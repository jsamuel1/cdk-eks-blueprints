import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms  from 'aws-cdk-lib/aws-kms';
import * as bp from '../lib';
import * as bcrypt from 'bcrypt';
import { KubernetesVersion } from 'aws-cdk-lib/aws-eks';
import { Stack } from 'aws-cdk-lib';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { DirectVpcProvider } from '../lib';

/**
 * You can run these examples with the following command:
 * <code>
 * npm run examples list
 * npm run examples deploy <blueprint-name>
 * </code>
 */
const app = new cdk.App();

const KMS_RESOURCE = "kms-key-22";
const base = bp.EksBlueprint.builder()
    .account(process.env.CDK_DEFAULT_ACCOUNT)
    .region(process.env.CDK_DEFAULT_REGION)
    .resourceProvider(bp.GlobalResources.Vpc, new bp.VpcProvider("default")) // saving time on VPC creation
    .resourceProvider(KMS_RESOURCE, {
        provide(context): cdk.aws_kms.Key {
            return new kms.Key(context.scope, KMS_RESOURCE);
        }
    });

const kmsKey: kms.Key = bp.getNamedResource(KMS_RESOURCE);
const builder = () => base.clone();

const publicCluster = {
    version: KubernetesVersion.V1_24, 
    vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }]
};

builder()
    .clusterProvider(new bp.FargateClusterProvider(publicCluster))
    .build(app, "fargate-blueprint");

builder()
    .clusterProvider(new bp.MngClusterProvider(publicCluster))
    .build(app, "mng-blueprint");

builder()
    .clusterProvider(new bp.MngClusterProvider(publicCluster))
    .addOns(buildArgoBootstrap())
    .build(app, 'argo-blueprint1');


class OtherStack extends Stack {

    public readonly vpc: Vpc;
    public readonly securityGroupWeb: ec2.ISecurityGroup;

    constructor() {
        super(app, "other-stack", {
            env: {
                account: process.env.CDK_DEFAULT_ACCOUNT,
                region: process.env.CDK_DEFAULT_REGION
            }
        });
        this.vpc = new Vpc(this, "central-vpc");
        this.securityGroupWeb = new ec2.SecurityGroup(this, 'service-sg-web', {
            vpc: this.vpc,
            securityGroupName: 'sg-web',
            description: 'Shared CDK-managed Security Group for HTTP(S) traffic'
        });
        this.securityGroupWeb.connections.allowFrom(ec2.Peer.ipv4('169.132.88.0/22'), ec2.Port.tcp(443), 'Allow HTTPS connections from internal network');
    }
}

const otherStack = new OtherStack();

builder()
    .clusterProvider(new bp.MngClusterProvider({
        ...publicCluster,
        securityGroup: otherStack.securityGroupWeb 
    }))
    .resourceProvider(bp.GlobalResources.Vpc, new DirectVpcProvider(otherStack.vpc))
    .account(process.env.CDK_DEFAULT_ACCOUNT)
    .region(process.env.CDK_DEFAULT_REGION)
    .build(app, "cross-stack-ref-blueprint");

function buildArgoBootstrap() {
    return new bp.addons.ArgoCDAddOn({
        bootstrapRepo: {
            repoUrl: 'https://github.com/aws-samples/eks-blueprints-add-ons.git',
            path: 'chart',
            targetRevision: "eks-blueprints-cdk",
        },
        bootstrapValues: {
            spec: {
                kmsKey: kmsKey.keyArn
            }
        },
        workloadApplications: [
            {
                name: "micro-services",
                namespace: "argocd",
                repository: {
                    repoUrl: 'https://github.com/aws-samples/eks-blueprints-workloads.git',
                    path: 'envs/dev',
                    targetRevision: "main",
                },
                values: {
                    domain: ""
                }
            }
        ],
        values: {
            configs: {
                secret: {
                    argocdServerAdminPassword: bcrypt.hash("argopwd1", 10)
                }
            }
        }
    });
}

