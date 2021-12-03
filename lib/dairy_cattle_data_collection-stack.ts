import * as path from 'path';

import * as ec2 from '@aws-cdk/aws-ec2';
import * as timestream from '@aws-cdk/aws-timestream';
import * as iam from '@aws-cdk/aws-iam';
import * as cdk from '@aws-cdk/core';
import * as cfninc from '@aws-cdk/cloudformation-include';

import {readFileSync} from 'fs';


export class DairyCattleDataCollectionStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a TimeStream Database and table to store sensor data
    const cfnDatabase = new timestream.CfnDatabase(this, 'TimeStreamDatabase', {
      databaseName: 'CFTestDB',
    });

    const cfnTable = new timestream.CfnTable(this, 'TimeStreamTable', {
      databaseName: 'CFTestDB',
      retentionProperties: {
        'MemoryStoreRetentionPeriodInHours': '24',
        'MagneticStoreRetentionPeriodInDays': '7'
      },
      tableName: 'CFTestTable'
    });

    // No cdk support yet for IoT topic rule actions. Therefore the resource
    // and IAM role is defined in a CloudFormation configuration file
    const timestreamRuleAction = new cfninc.CfnInclude(this, 'Template', { 
      templateFile: path.join(__dirname, 'iot_rule_action.yaml'),
      parameters: {
        'TimeStreamTableARN': cfnTable.attrArn
      }
    });

    // Define an EC2 instance
    const vpc = new ec2.Vpc(this, 'VPC');
    const mySecurityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: 'Allow ssh and Grafana access to ec2 instance',
      allowAllOutbound: true
    });
    mySecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'allow ssh access from anywhere');
    mySecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3000), 'allow Grafana access from anywhere');

    const timestreamAccessRole = new iam.Role(this, 'TimestreamAccessRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonTimestreamFullAccess'),
      ],
    });

    const ec2Instance = new ec2.Instance(this, 'grafana-instance', {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      role: timestreamAccessRole,
      securityGroup: mySecurityGroup,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        ec2.InstanceSize.MICRO,
      ),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      keyName: 'AWS',
    });

    const userDataScript = readFileSync('./lib/EC2StartupCommands.sh', 'utf8');
    ec2Instance.addUserData(userDataScript);
  }
}