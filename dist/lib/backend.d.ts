import { type Express } from 'express';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
export type CreateServerOptions = {
    dynamoDbClient?: DynamoDBClient;
    expressInstance?: Express;
    dynamoEndpoint?: string;
    skipDefaultCredentials?: boolean;
    basePath?: string;
};
export declare function createServer(options?: CreateServerOptions): Express;
