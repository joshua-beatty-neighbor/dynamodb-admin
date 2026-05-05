import type { AttributeDefinition, KeySchemaElement, QueryInput, TableDescription } from '@aws-sdk/client-dynamodb';
import { NumberValue, type ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import type { DynamoApiController } from './dynamoDbApi';
import type { ItemList, Key } from './types';
export declare class DynamoDBAdminError extends Error {
    status: number;
    constructor(message: string, status?: number);
}
export type ScanParams = Omit<ScanCommandInput & QueryInput, 'TableName' | 'Limit'>;
export declare function extractKey(item: Record<string, any>, keySchema: KeySchemaElement[]): Record<string, any>;
export declare function parseKey(keys: string, tableDescription: TableDescription): Record<string, string | number | NumberValue>;
export declare function extractKeysForItems(Items: Record<string, any>[]): string[];
/**
 * Invokes a database scan
 *
 * @param ddbApi The AWS DynamoDB client
 * @param tableName The table name
 * @param scanParams Extra params for the query
 * @param limit The of items to request per chunked query. NOT a limit
 *                       of items that should be returned.
 * @param startKey The key to start query from
 * @param progress Function to execute on each new items returned from query. Returns true to stop the query.
 * @param readOperation The read operation
 */
export declare function doSearch(ddbApi: DynamoApiController, tableName: string, scanParams: ScanParams, limit?: number, progress?: (items: ItemList | undefined, lastStartKey: Key | undefined) => boolean, readOperation?: 'query' | 'scan'): Promise<ItemList>;
/**
 * Convert a numeric string to a plain JS number if it can be represented
 * without precision loss, otherwise wrap it in NumberValue for the DynamoDB SDK.
 */
export declare function safeNumber(value: string): number | NumberValue;
export declare function isAttributeNotAlreadyCreated(attributeDefinitions: AttributeDefinition[], attributeName: string): boolean;
