import type { KeySchemaElement } from '@aws-sdk/client-dynamodb';
import { type ScanParams } from '../util';
import type { DynamoApiController } from '../dynamoDbApi';
export declare function getPage(ddbApi: DynamoApiController, keySchema: KeySchemaElement[], TableName: string, scanParams: ScanParams, pageSize: number, operationType: 'query' | 'scan'): Promise<{
    pageItems: Record<string, any>[];
    nextKey: any;
}>;
