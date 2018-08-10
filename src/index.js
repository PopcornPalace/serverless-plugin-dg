'use strict';

const _ = require('lodash');

module.exports = function (serverless) {
    this.hooks = {
        'before:deploy:deploy': function () {
            serverless.cli.log('Commencing API Gateway stage configuration');

            const logRoleLogicalName = 'IamRoleApiGatewayCloudwatchLogRole';
            const stageSettings = serverless.service.custom.stageSettings || {};
            const template = serverless.service.provider.compiledCloudFormationTemplate;
            const deployments = _(template.Resources)
                .pickBy((resource) => resource.Type === 'AWS::ApiGateway::Deployment');

            let custom = serverless.service.custom
            const lambdas = _(template.Resources)
              .pickBy((resource) => resource.Type === 'AWS::Lambda::Function').value()

            if(custom.dlq_arn)
              for(var k in lambdas)
                if(!lambdas[k].Properties.DeadLetterConfig)
                  lambdas[k].Properties.DeadLetterConfig = {TargetArn: custom.dlq_arn}


            // TODO Handle other resources - ApiKey, BasePathMapping, UsagePlan, etc
            _.extend(template.Resources,
                // Enable logging: IAM role for API Gateway, and API Gateway account settings
                {
                    [logRoleLogicalName]: {
                        Type: 'AWS::IAM::Role',
                        Properties: {
                            AssumeRolePolicyDocument: {
                                Version: '2012-10-17',
                                Statement: [
                                    {
                                        Effect: 'Allow',
                                        Principal: {
                                            Service: [
                                                'apigateway.amazonaws.com'
                                            ]
                                        },
                                        Action: [
                                            'sts:AssumeRole'
                                        ]
                                    }
                                ]
                            },
                            Policies: [
                                {
                                    PolicyName: {
                                        'Fn::Join': [
                                            '-',
                                            [
                                                serverless.service.custom.stage,
                                                serverless.service.service,
                                                'apiGatewayLogs'
                                            ]
                                        ]
                                    },
                                    PolicyDocument: {
                                        Version: '2012-10-17',
                                        Statement: [
                                            {
                                                Effect: 'Allow',
                                                Action: [
                                                    'logs:CreateLogGroup',
                                                    'logs:CreateLogStream',
                                                    'logs:DescribeLogGroups',
                                                    'logs:DescribeLogStreams',
                                                    'logs:PutLogEvents',
                                                    'logs:GetLogEvents',
                                                    'logs:FilterLogEvents'
                                                ],
                                                Resource: '*'
                                            }
                                        ]
                                    }
                                }
                            ],
                            Path: '/',
                            RoleName: {
                                'Fn::Join': [
                                    '-',
                                    [
                                        serverless.service.service,
                                        serverless.service.custom.stage,
                                        serverless.service.custom.region,
                                        'apiGatewayLogRole'
                                    ]
                                ]
                            }
                        }
                    },
                    ApiGatewayAccount: {
                        Type: 'AWS::ApiGateway::Account',
                        Properties: {
                            CloudWatchRoleArn: {
                                'Fn::GetAtt': [
                                    logRoleLogicalName,
                                    'Arn'
                                ]
                            }
                        },
                        DependsOn: [
                            logRoleLogicalName
                        ]
                    }
                },

                // Stages, one per deployment.  TODO Support multiple stages?
                deployments
                    .mapValues((deployment, deploymentKey) => ({
                        Type: 'AWS::ApiGateway::Stage',
                        Properties: {
                            StageName: deployment.Properties.StageName,
                            Description: `${deployment.Properties.StageName} stage of ${serverless.service.service}`,
                            RestApiId: {
                                Ref: 'ApiGatewayRestApi'
                            },
                            DeploymentId: {
                                Ref: deploymentKey
                            },
                            CacheClusterEnabled: stageSettings.CacheClusterEnabled || false,
                            CacheClusterSize: stageSettings.CacheClusterSize,
                            Variables: stageSettings.Variables || {},
                            MethodSettings: _.union([
                                _.defaults(
                                    stageSettings.DefaultMethodSettings || {},
                                    {
                                        DataTraceEnabled: stageSettings.DefaultMethodSettings.DataTraceEnabled || false,
                                        HttpMethod: '*',
                                        ResourcePath: '/*',
                                        MetricsEnabled: stageSettings.DefaultMethodSettings.MetricsEnabled || false
                                    }
                                )
                            ], stageSettings.MethodSettingsOverrides || [])
                        }
                    }))
                    .mapKeys((deployment, deploymentKey) => `ApiGatewayStage${_.upperFirst(deployment.Properties.StageName)}`)
                    .value(),

                // Deployments, with the stage name removed (the Stage's DeploymentId property is used instead).
                deployments
                    .mapValues((deployment) => _.omit(deployment, 'Properties.StageName'))
                    .value()
            );

            serverless.cli.log('API Gateway stage configuration complete');
        }
    };
};
