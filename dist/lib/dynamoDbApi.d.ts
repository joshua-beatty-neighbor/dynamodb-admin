import { type CreateTableInput, type CreateTableOutput, type DeleteTableInput, type DeleteTableOutput, type DescribeTableInput, type DynamoDBClient, type ListTablesInput, type ListTablesOutput, type TableDescription } from '@aws-sdk/client-dynamodb';
import { type BatchWriteCommandInput, type BatchWriteCommandOutput, type DeleteCommandInput, type DeleteCommandOutput, DynamoDBDocumentClient, type GetCommandInput, type GetCommandOutput, type PutCommandInput, type PutCommandOutput, type QueryCommandInput, type QueryCommandOutput, type ScanCommandInput, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
export declare class DynamoApiController {
    dynamodb: DynamoDBClient;
    docClient: DynamoDBDocumentClient;
    constructor(dynamodb: DynamoDBClient);
    batchWriteItem(input: BatchWriteCommandInput): Promise<BatchWriteCommandOutput>;
    createTable(input: CreateTableInput): Promise<CreateTableOutput>;
    deleteItem(input: DeleteCommandInput): Promise<DeleteCommandOutput>;
    deleteTable(input: DeleteTableInput): Promise<DeleteTableOutput>;
    describeTable(input: DescribeTableInput): Promise<TableDescription>;
    listTables(input: ListTablesInput): Promise<ListTablesOutput>;
    query(input: QueryCommandInput): Promise<QueryCommandOutput>;
    scan(input: ScanCommandInput): Promise<ScanCommandOutput>;
    getItem(input: GetCommandInput): Promise<GetCommandOutput>;
    putItem(input: PutCommandInput): Promise<PutCommandOutput>;
}
