import type { DynamoApiController } from '../dynamoDbApi';
/**
 * This function deletes all record from a given table within dynamodb.
 *
 * It functions as follows:
 *  1) Determine the primary key of the table by calling describeTable
 *  2) Scan all records and store them in an array
 *  3) Pass the records to #deleteAllElements which in turn sends a delete request for each
 *  of them
 *  4) Return a list of promises using Promise.all() to the caller
 *
 * @param tableName the table we want to purge
 * @param ddbApi the AWS dynamodb service that holds the connection
 * @returns concatenation of all delete request promises
 */
export declare function purgeTable(tableName: string, ddbApi: DynamoApiController): Promise<void>;
