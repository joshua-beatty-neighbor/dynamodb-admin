import { type Express } from 'express';
import type { DynamoApiController } from './dynamoDbApi';
export declare function setupRoutes(app: Express, ddbApi: DynamoApiController, basePath?: string): void;
