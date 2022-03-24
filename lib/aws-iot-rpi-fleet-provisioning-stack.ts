// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3Assets from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipelineActions from 'aws-cdk-lib/aws-codepipeline-actions';

import { Construct } from 'constructs';

export interface AwsIotRpiFleetProvisioningStackProps extends cdk.StackProps {
  /**
   * SSH Key that's used for logging into the Raspberry Pi
   */
  sshPublicKey: string;
  /**
   * Name of the secret where the password used by the Raspberry Pi to connect to the Wifi is stored
   */
  // wifiPasswordSecretName: string;
  /**
   * Country code for the Wifi network (e.g. 'US')
   */
  wifiCountry: string;
  /**
   * SSID of the Wifi network the Raspberry Pi will connect to
   */
  wifiSsid: string;
}

export class AwsIotRpiFleetProvisioningStack extends cdk.Stack {
  /**
   * Name of the archive containing the configured Raspberry pi image builder
   */
  private readonly rpiImageBuilderArchiveName: string = 'rpi-image-builder.zip';
  /**
   * Name of the archive containing the custom Raspberry pi image
   */
  private readonly customImageArchiveName: string = 'aws-raspbian.zip';

  /**
   * Create a CodePipeline that builds a custom raspbian image.
   * This custom raspbian image automatically provisions a RaspberryPi with AWS IoT on its first boot.
   * @param scope 
   * @param id 
   * @param props 
   */
  constructor(scope: Construct, id: string, props: AwsIotRpiFleetProvisioningStackProps) {
    super(scope, id, props);

    // Policy attached to IoT things generated by this stack
    const thingsPolicy = new iot.CfnPolicy(this, 'thingsPolicy', {
      policyDocument: {
        'Version': '2012-10-17',
        'Statement': [
          {
            "Effect": "Allow",
            "Action": [
              "iot:Connect"
            ],
            "Resource": [
              `arn:aws:iot:${this.region}:${this.account}:client/\${iot:Connection.Thing.ThingName}`,
            ]
          },
          {
              "Effect": "Allow",
              "Action": [
                  "iot:Subscribe",
              ],
              "Resource": [
                `arn:aws:iot:${this.region}:${this.account}:topicfilter/\${iot:Connection.Thing.ThingName}/*`,
                `arn:aws:iot:${this.region}:${this.account}:topicfilter/openworld`,
              ]
          },
          {
              "Effect": "Allow",
              "Action": [
                  "iot:Publish",
                  "iot:Receive",
              ],
              "Resource": [
                  `arn:aws:iot:${this.region}:${this.account}:topic/\${iot:Connection.Thing.ThingName}/*`,
                  `arn:aws:iot:${this.region}:${this.account}:topic/openworld`,
              ]
          },
        ]
      }
    });

    // Give the AWS IoT service permission to create or update IoT resources such as things and certificates in your account when provisioning devices
    const provisioningRole = new iam.Role(this, 'ProvisioningRoleArn', {
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
    });
    provisioningRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSIoTThingsRegistration'));

    // The provisioning template used to create IoT things
    // https://docs.aws.amazon.com/iot/latest/developerguide/provision-template.html
    const provisioningTemplate = new iot.CfnProvisioningTemplate(this, 'ProvisioningTemplate', {
      provisioningRoleArn: provisioningRole.roleArn,
      enabled: true,
      templateBody: `{
        "Parameters": {
          "SerialNumber": {
            "Type": "String"
          },
          "AWS::IoT::Certificate::Id": {
            "Type": "String"
          }
        },
        "Resources": {
          "certificate": {
            "Properties": {
              "CertificateId": {
                "Ref": "AWS::IoT::Certificate::Id"
              },
              "Status": "Active"
            },
            "Type": "AWS::IoT::Certificate"
          },
          "policy": {
            "Properties": {
              "PolicyName": "${thingsPolicy.ref}"
            },
            "Type": "AWS::IoT::Policy"
          },
          "thing": {
            "OverrideSettings": {
              "AttributePayload": "MERGE",
              "ThingGroups": "DO_NOTHING",
              "ThingTypeName": "REPLACE"
            },
            "Properties": {
              "ThingGroups": [],
              "ThingName": {
                "Ref": "SerialNumber"
              }
            },
            "Type": "AWS::IoT::Thing"
          }
        },
        "DeviceConfiguration": {
        }
      }`
    });

    // AWS IoT fleet provisioning uses claim certificates to generate things certificates
    // This policy restricts the use of claim certificates to device provisioning
    const fleetProvisioningPolicy = new iot.CfnPolicy(this, 'FleetProvisioningPolicy', {
      policyDocument: {
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": ["iot:Connect"],
            "Resource": ["*"]
          },
          {
            "Effect": "Allow",
            "Action": ["iot:Publish", "iot:Receive"],
            "Resource": [
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/certificates/create/*`,
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/provisioning-templates/${provisioningTemplate.ref}/provision/*`
            ]
          },
          {
            "Effect": "Allow",
            "Action": ["iot:Subscribe"],
            "Resource": [
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/$aws/certificates/create/*`,
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/$aws/provisioning-templates/${provisioningTemplate.ref}/provision/*`
            ]
          }
        ]
      }
    });

    // The bucket where the configured rpi-image-builder used as a source of the pipeline is stored
    const rpiImageBuilderSourceBucket = new s3.Bucket(this, 'rpiImageBuilderSourceBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true, // CodePipeline requires a versioned source for source stages
    });

    // The bucket where the custom raspbian image created by the pipeline is stored
    const rpiImageOutputBucket = new s3.Bucket(this, 'RpiImageOutputBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Lambda that configures the rpi-image-builder and stores it in the pipeline source bucket
    const configureRpiImageBuilderFunction = new lambda.Function(this, 'ConfigureRpiImageBuilderFunction', {
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: 'app.on_event',
      code: lambda.Code.fromAsset(path.join(__dirname, './lambda/configure_rpi_image_builder')),
      timeout: cdk.Duration.seconds(60),
      initialPolicy: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'iot:CreateKeysAndCertificate',
            'iot:AttachPolicy',
            'iot:DescribeEndpoint',
          ],
          resources: ['*'],
        }),
      ],
    });

    // Store the rpi-image-builder source code in S3
    const rpiImageBuilderAsset = new s3Assets.Asset(this, 'RpiImageBuilderAsset', {
      path: path.join(__dirname, '../rpi-image-builder'),
    });

    rpiImageBuilderSourceBucket.grantWrite(configureRpiImageBuilderFunction);
    rpiImageBuilderAsset.grantRead(configureRpiImageBuilderFunction);

    // Custom resource that calls the Lambda that will configure the rpi-image-builder client
    new cdk.CustomResource(this, 'ConfigureRpiImageBuilderCR', {
      serviceToken: new cr.Provider(this, 'ConfigureRpiImageBuilderProvider', {
        onEventHandler: configureRpiImageBuilderFunction,
      }).serviceToken,
      properties: {
        'FLEET_PROVISIONING_POLICY_NAME': fleetProvisioningPolicy.ref,
        'PROVISIONING_TEMPLATE_NAME': provisioningTemplate.ref,
        'RPI_IMAGE_BUILDER_BUCKET_NAME': rpiImageBuilderAsset.s3BucketName,
        'RPI_IMAGE_BUILDER_OBJECT_KEY': rpiImageBuilderAsset.s3ObjectKey,
        'CONFIGURED_RPI_IMAGE_BUILDER_BUCKET_NAME': rpiImageBuilderSourceBucket.bucketName,
        'CONFIGURED_RPI_IMAGE_BUILDER_OBJECT_KEY': this.rpiImageBuilderArchiveName,
      },
    });

    // Codebuild project that generates the custom raspbian image
    const buildRpiImageProject = new codebuild.PipelineProject(this, 'BuildRpiImageProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_4_0,
        privileged: true,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        env: {
          variables: {
            // Set environment variables expected by the build-rpi-image.bash script
            'SSH_PUBLIC_KEY': props.sshPublicKey,
            'WIFI_SSID': props.wifiSsid,
            'WIFI_COUNTRY': props.wifiCountry,
            'ARTIFACT_IMAGE_NAME': 'aws-raspbian.img',
          },
          // 'secrets-manager': {
          //   'WIFI_PASSWORD': `${props.wifiPasswordSecretName}`,
          // },
        },
        phases: {
          install: {
            commands: [
              // Install dependencies required by the build-rpi-image.bash script
              'apt-get update',
              'apt-get -y install p7zip-full wget libxml2-utils kpartx',
            ],
          },
          build: {
            commands: [
              './build-rpi-image.bash'
            ],
          },
        },
        artifacts: {
          files: [
            '$ARTIFACT_IMAGE_NAME',
          ],
        },
      }),
    });

    // Give access to the secret containing the wifi password to the codebuild project
    // if (buildRpiImageProject.role) {
    //   const rpiSecret = secrets.Secret.fromSecretNameV2(this, 'RPISecrets', props.wifiPasswordSecretName);
    //   rpiSecret.grantRead(buildRpiImageProject.role);
    // }

    const pipelineSourceArtifact = new codepipeline.Artifact();
    const buildOutputArtifact = new codepipeline.Artifact();

    new codepipeline.Pipeline(this, 'BuildRpiImagePipeline', {
      crossAccountKeys: false,
      restartExecutionOnUpdate: true,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipelineActions.S3SourceAction({
              actionName: 'Source',
              bucket: rpiImageBuilderSourceBucket,
              bucketKey: this.rpiImageBuilderArchiveName,
              output: pipelineSourceArtifact,
            }),
          ],
        },
        {
          stageName: 'BuildRpiImage',
          actions: [
            new codepipelineActions.CodeBuildAction({
              actionName: 'BuildRpiImage',
              input: pipelineSourceArtifact,
              project: buildRpiImageProject,
              outputs: [buildOutputArtifact],
            }),
          ],
        },
        {
          stageName: 'StoreRpiImage',
          actions: [
            new codepipelineActions.S3DeployAction({
              actionName: 'StoreRpiImage',
              input: buildOutputArtifact,
              bucket: rpiImageOutputBucket,
              extract: false,
              objectKey: this.customImageArchiveName,
            }),
          ],
        },
      ],
    });

    new cdk.CfnOutput(this, 'RpiImageBucketName', {
      description: 'Download the raspbian image from this S3 bucket',
      value: rpiImageOutputBucket.bucketName,
    });

  }
}
