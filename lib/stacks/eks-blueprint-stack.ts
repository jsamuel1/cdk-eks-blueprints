
import * as cdk from '@aws-cdk/core';
import * as ec2 from "@aws-cdk/aws-ec2";
import { StackProps } from '@aws-cdk/core';
import { IVpc } from '@aws-cdk/aws-ec2';
import { KubernetesVersion } from '@aws-cdk/aws-eks';
import { Construct } from 'constructs';
import { EC2ClusterProvider } from '../cluster-providers/ec2-cluster-provider';
import { ClusterAddOn, Team, ClusterProvider, ClusterPostDeploy, StackBuilder } from '../spi';
import { withUsageTracking } from '../utils/usage-utils';

export class EksBlueprintProps {

    /**
     * The id for the blueprint.
     */
    readonly id: string;

    /**
     * Defaults to id if not provided
     */
    readonly name?: string;

    /**
     * Add-ons if any.
     */
    readonly addOns?: Array<ClusterAddOn> = [];

    /**
     * Teams if any
     */
    readonly teams?: Array<Team> = [];

    /**
     * EC2 or Fargate are supported in the blueprint but any implementation conforming the interface
     * will work
     */
    readonly clusterProvider?: ClusterProvider = new EC2ClusterProvider;

    /**
     * Kubernetes version (must be initialized for addons to work properly)
     */
    readonly version?: KubernetesVersion = KubernetesVersion.V1_20;

}


/**
 * Blueprint builder implements a builder pattern that improves readability (no bloated constructors)
 * and allows creating a blueprint in an abstract state that can be applied to various instantiations 
 * in accounts and regions. 
 */
export class BlueprintBuilder implements StackBuilder {

    private props: Partial<EksBlueprintProps>;
    private env: {
        account?: string,
        region?: string
    }

    constructor() {
        this.props = { addOns: new Array<ClusterAddOn>(), teams: new Array<Team>()};
        this.env = {};
    }

    public name(name: string) : this {
        this.props = {...this.props, ...{name}};
        return this;
    }

    public account(account?: string): this {
        this.env.account = account;
        return this;
    }

    public region(region?: string) : this {
        this.env.region = region;
        return this;
    }

    public withBlueprintProps(props: Partial<EksBlueprintProps>) : this {
        this.props = {...this.props, ...props};
        return this;
    }

    public addons(...addOns: ClusterAddOn[]) : this {
        this.props = {...this.props, ...{ addOns: this.props.addOns?.concat(addOns)}};
        return this;
    }

    public clusterProvider(clusterProvider: ClusterProvider) {
        this.props = {...this.props, ...{ clusterProvider: clusterProvider }};
        return this;
    }

    public id( id: string): this {
        this.props = { ...this.props, ...{id}};
        return this;
    }

    public teams(...teams: Team[]) : this {
        this.props = {...this.props, ...{teams: this.props.teams?.concat(teams)}};
        return this;
    }

    public clone(region?: string, account?: string): BlueprintBuilder {
        return new BlueprintBuilder().withBlueprintProps({...this.props})
            .account(account).region(region);
    }

    public build(scope: Construct, id: string, stackProps? : StackProps): EksBlueprint {
        return new EksBlueprint(scope, {...this.props, ...{id}}, 
            {...stackProps, ...{ env: this.env}});
    }
}


/**
 * Entry point to the platform provisioning. Creates a CFN stack based on the provided configuration
 * and orcherstrates provisioning of add-ons, teams and post deployment hooks. 
 */
export class EksBlueprint extends cdk.Stack {

    static readonly USAGE_ID = "qs-1s1r465hk";

    public static builder() : BlueprintBuilder {
        return new BlueprintBuilder();
    }
    
    constructor(scope: Construct, blueprintProps: EksBlueprintProps, props?: StackProps) {
        super(scope, blueprintProps.id, withUsageTracking(EksBlueprint.USAGE_ID, props));
        this.validateInput(blueprintProps);
        /*
         * Supported parameters
        */
        const vpcId = this.node.tryGetContext("vpc");
        const vpc = this.initializeVpc(vpcId);

        const clusterProvider = blueprintProps.clusterProvider ?? new EC2ClusterProvider;

        const clusterInfo = clusterProvider.createCluster(this, vpc, blueprintProps.version ?? KubernetesVersion.V1_19);
        const postDeploymentSteps = Array<ClusterPostDeploy>();
        const promises = Array<Promise<any>>();

        for (let addOn of (blueprintProps.addOns ?? [])) { // must iterate in the strict order
            const result : any = addOn.deploy(clusterInfo);
            if(result) {
                promises.push(<Promise<any>>result);
            }
            const postDeploy : any = addOn;
            if((postDeploy as ClusterPostDeploy).postDeploy !== undefined) {
                postDeploymentSteps.push(<ClusterPostDeploy>postDeploy);
            }
        }
        
        if (blueprintProps.teams != null) {
            for(let team of blueprintProps.teams) {
                team.setup(clusterInfo);
            }
        }

        Promise.all(promises).then(() => {
            for(let step of postDeploymentSteps) {
                step.postDeploy(clusterInfo, blueprintProps.teams ?? []);
            }
        }).catch(err => { throw new Error(err)});
    }

    private validateInput(blueprintProps: EksBlueprintProps) {
        const teamNames = new Set<string>();
        if (blueprintProps.teams) {
            blueprintProps.teams.forEach(e => {
                if (teamNames.has(e.name)) {
                    throw new Error(`Team ${e.name} is registered more than once`);
                }
                teamNames.add(e.name);
            });
        }
    }

    initializeVpc(vpcId: string): IVpc {
        const id = this.node.id;
        let vpc = undefined;

        if (vpcId != null) {
            if (vpcId === "default") {
                console.log(`looking up completely default VPC`);
                vpc = ec2.Vpc.fromLookup(this, id + "-vpc", { isDefault: true });
            } else {
                console.log(`looking up non-default ${vpcId} VPC`);
                vpc = ec2.Vpc.fromLookup(this, id + "-vpc", { vpcId: vpcId });
            }
        }

        if (vpc == null) {
            // It will automatically divide the provided VPC CIDR range, and create public and private subnets per Availability Zone.
            // Network routing for the public subnets will be configured to allow outbound access directly via an Internet Gateway.
            // Network routing for the private subnets will be configured to allow outbound access via a set of resilient NAT Gateways (one per AZ).
            vpc = new ec2.Vpc(this, id + "-vpc");
        }

        return vpc;
    }
}