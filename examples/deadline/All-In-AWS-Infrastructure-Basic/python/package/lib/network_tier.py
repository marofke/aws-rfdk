# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from aws_cdk.core import (
    Stack,
    Construct
)

from aws_cdk.aws_ec2 import (
    FlowLogDestination,
    FlowLogTrafficType,
    GatewayVpcEndpointAwsService,
    InterfaceVpcEndpointAwsService,
    Vpc,
    SubnetConfiguration,
    SubnetSelection,
    SubnetType
)

from aws_cdk.aws_route53 import (
    PrivateHostedZone
)

_INTERFACE_ENDPOINT_SERVICES = [
    {'name': 'CLOUDWATCH', 'service': InterfaceVpcEndpointAwsService.CLOUDWATCH},
    {'name': 'CLOUDWATCH_EVENTS', 'service': InterfaceVpcEndpointAwsService.CLOUDWATCH_EVENTS},
    {'name': 'CLOUDWATCH_LOGS', 'service': InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS},
    {'name': 'EC2', 'service': InterfaceVpcEndpointAwsService.EC2},
    {'name': 'ECR', 'service': InterfaceVpcEndpointAwsService.ECR},
    {'name': 'ECS', 'service': InterfaceVpcEndpointAwsService.ECS},
    {'name': 'KMS', 'service': InterfaceVpcEndpointAwsService.KMS},
    {'name': 'SECRETS_MANAGER', 'service': InterfaceVpcEndpointAwsService.SECRETS_MANAGER},
    {'name': 'SNS', 'service': InterfaceVpcEndpointAwsService.SNS},
    {'name': 'STS', 'service': InterfaceVpcEndpointAwsService.STS}
]

_GATEWAY_ENDPOINT_SERVICES = [
    {'name': 'S3', 'service': GatewayVpcEndpointAwsService.S3},
    {'name': 'DYNAMODB', 'service': GatewayVpcEndpointAwsService.DYNAMODB}
]


class NetworkTier(Stack):
    """
    The network tier consists of all constructs that are required for the foundational
    networking between the various components of the Deadline render farm.
    """

    def __init__(self, scope: Construct, stack_id: str, **kwargs) -> None:
        """
        Initializes a new instance of NetworkTier
        :param scope: The scope of this construct.
        :param stack_id: The ID of this construct.
        :param kwargs: The stack properties.
        """
        super().__init__(scope, stack_id, **kwargs)

        # The VPC that all components of the render farm will be created in.
        self.vpc = Vpc(
            self,
            'Vpc',
            max_azs=2,
            subnet_configuration=[
                SubnetConfiguration(
                    name='Public',
                    subnet_type=SubnetType.PUBLIC,
                    cidr_mask=28
                ),
                SubnetConfiguration(
                    name='Private',
                    subnet_type=SubnetType.PRIVATE,
                    cidr_mask=18  # 16,382 IP addresses
                )
            ]
        )
        # VPC flow logs are a security best-practice as they allow us
        # to capture information about the traffic going in and out of
        # the VPC. For more information, see the README for this app.
        self.vpc.add_flow_log(
            'NetworkTierFlowLogs',
            destination=FlowLogDestination.to_cloud_watch_logs(),
            traffic_type=FlowLogTrafficType.ALL
        )

        # TODO - Create a NetworkAcl for your VPC that only allows
        # network traffic required for your render farm. This is a
        # security best-practice to ensure the safety of your farm.
        # The default network ACLs allow all traffic by default,
        # whereas custom network ACLs deny all traffic by default.
        # For more information, see the README for this app.
        #
        # Example code to create a custom network ACL:
        # acl = NetworkAcl(
        #     self,
        #     'ACL',
        #     vpc=self.vpc,
        #     subnet_selection=SubnetSelection(
        #         subnets=self.vpc.public_subnets
        #     )
        # )
        #
        # You can optionally add rules to allow traffic (e.g. SSH):
        # acl.add_entry(
        #     'SSH',
        #     cidr=AclCidr.ipv4(
        #         # some-ipv4-address-cidr
        #     ),
        #     traffic=AclTraffic.tcp_port(22),
        #     rule_number=1
        # )
        endpoint_subnets = SubnetSelection(subnet_type=SubnetType.PRIVATE)

        # Add interface endpoints
        for idx, service_info in enumerate(_INTERFACE_ENDPOINT_SERVICES):
            service_name = service_info['name']
            service = service_info['service']
            self.vpc.add_interface_endpoint(
                f'{service_name}{idx}',
                service=service,
                subnets=endpoint_subnets
            )

        # Add gateway endpoints
        for idx, service_info in enumerate(_GATEWAY_ENDPOINT_SERVICES):
            service_name = service_info['name']
            service = service_info['service']
            self.vpc.add_gateway_endpoint(
                service_name,
                service=service,
                subnets=[endpoint_subnets]
            )

        # Internal DNS zone for the VPC.
        self.dns_zone = PrivateHostedZone(
            self,
            'DnsZone',
            vpc=self.vpc,
            zone_name='deadline-test.internal'
        )
