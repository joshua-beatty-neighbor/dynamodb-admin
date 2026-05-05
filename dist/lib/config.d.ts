import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
type CreateAwsConfigOptions = {
    dynamoEndpoint?: string;
    skipDefaultCredentials?: boolean;
};
/**
 * Create the configuration for the local dynamodb instance.
 *
 * AWS SDK default credentials provider resolves configuration from the following sources:
 * https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html
 */
export declare function createAwsConfig({ dynamoEndpoint, skipDefaultCredentials }: CreateAwsConfigOptions): DynamoDBClientConfig;
export {};
