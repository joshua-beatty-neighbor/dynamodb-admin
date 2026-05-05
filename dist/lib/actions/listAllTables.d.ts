import type { TableDescription } from '@aws-sdk/client-dynamodb';
import type { DynamoApiController } from '../dynamoDbApi';
export declare function listAllTables(ddbApi: DynamoApiController): Promise<TableDescription[]>;
