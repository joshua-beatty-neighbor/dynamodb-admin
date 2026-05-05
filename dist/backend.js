#!/usr/bin/env node
'use strict';

Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const path = require('node:path');
const express = require('express');
const clientDynamodb = require('@aws-sdk/client-dynamodb');
const clc = require('cli-color');
const errorhandler = require('errorhandler');
const bodyParser = require('body-parser');
const pickBy = require('lodash.pickby');
const cookieParser = require('cookie-parser');
const libDynamodb = require('@aws-sdk/lib-dynamodb');
const utilDynamodb = require('@aws-sdk/util-dynamodb');

/**
 * Create the configuration for the local dynamodb instance.
 *
 * AWS SDK default credentials provider resolves configuration from the following sources:
 * https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html
 */
function createAwsConfig({ dynamoEndpoint, skipDefaultCredentials }) {
    const dynamoConfig = {
        endpoint: dynamoEndpoint || 'http://localhost:8000',
    };
    if (!skipDefaultCredentials) {
        dynamoConfig.region = process.env.AWS_REGION ?? 'us-east-1';
        dynamoConfig.credentials = {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'key',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'secret',
        };
    }
    if (!dynamoEndpoint) {
        if (typeof process.env.DYNAMO_ENDPOINT === 'string') {
            if (process.env.DYNAMO_ENDPOINT.indexOf('.amazonaws.com') > -1) {
                console.error(clc.red('dynamodb-admin is only intended for local development'));
                process.exit(1);
            }
            dynamoConfig.endpoint = process.env.DYNAMO_ENDPOINT;
        }
        else {
            console.info(clc.yellow('  DYNAMO_ENDPOINT is not defined (using default of http://localhost:8000)'));
        }
    }
    console.info(clc.blackBright(`  database endpoint: \t${dynamoConfig.endpoint}`));
    if (dynamoConfig.region) {
        console.info(clc.blackBright(`  region: \t\t${dynamoConfig.region}`));
    }
    if (dynamoConfig.credentials && 'accessKeyId' in dynamoConfig.credentials) {
        console.info(clc.blackBright(`  accessKey: \t\t${dynamoConfig.credentials.accessKeyId}\n`));
    }
    return dynamoConfig;
}

class DynamoDBAdminError extends Error {
    status;
    constructor(message, status = 500) {
        super(message);
        this.status = status;
    }
}
function extractKey(item, keySchema) {
    return keySchema.reduce((prev, current) => {
        return {
            ...prev,
            ...current.AttributeName ? { [current.AttributeName]: item[current.AttributeName] } : {},
        };
    }, {});
}
function parseKey(keys, tableDescription) {
    const splitKeys = keys.split(',');
    return tableDescription.KeySchema.reduce((prev, current, index) => {
        return {
            ...prev,
            ...current.AttributeName ? { [current.AttributeName]: typecastKey(current.AttributeName, splitKeys[index], tableDescription) } : {},
        };
    }, {});
}
function extractKeysForItems(Items) {
    const keys = new Set();
    for (const item of Items) {
        for (const key of Object.keys(item)) {
            if (!keys.has(key)) {
                keys.add(key);
            }
        }
    }
    return Array.from(keys);
}
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
async function doSearch(ddbApi, tableName, scanParams, limit, progress, readOperation = 'scan') {
    const params = {
        TableName: tableName,
        ...scanParams ? scanParams : {},
        ...limit !== undefined ? { Limit: limit } : {},
    };
    let items = [];
    const getNextBite = async (params, nextKey = undefined) => {
        if (nextKey) {
            params.ExclusiveStartKey = nextKey;
        }
        const data = await ddbApi[readOperation](params);
        if (data.Items && data.Items.length > 0) {
            items = items.concat(data.Items);
        }
        let lastStartKey = undefined;
        if (data) {
            lastStartKey = data.LastEvaluatedKey;
        }
        if (progress) {
            const stop = progress(data.Items, lastStartKey);
            if (stop) {
                return items;
            }
        }
        if (!lastStartKey) {
            return items;
        }
        return await getNextBite(params, lastStartKey);
    };
    return await getNextBite(params);
}
/**
 * Convert a numeric string to a plain JS number if it can be represented
 * without precision loss, otherwise wrap it in NumberValue for the DynamoDB SDK.
 */
function safeNumber(value) {
    const num = Number(value);
    if (Number.isFinite(num) && String(num) === value) {
        return num;
    }
    return new libDynamodb.NumberValue(value);
}
function typecastKey(keyName, keyValue, table) {
    const definition = table.AttributeDefinitions.find(attribute => attribute.AttributeName === keyName);
    if (definition) {
        switch (definition.AttributeType) {
            case 'N':
                return safeNumber(keyValue);
            case 'S':
                return String(keyValue);
        }
    }
    return keyValue;
}
function isAttributeNotAlreadyCreated(attributeDefinitions, attributeName) {
    return !attributeDefinitions.find(attributeDefinition => attributeDefinition.AttributeName === attributeName);
}

async function getPage(ddbApi, keySchema, TableName, scanParams, pageSize, operationType) {
    const pageItems = [];
    function onNewItems(items, lastStartKey) {
        if (items) {
            for (let i = 0; i < items.length && pageItems.length < pageSize + 1; i++) {
                pageItems.push(items[i]);
            }
        }
        // If there is more items to query (!lastStartKey) then don't stop until
        // we are over pageSize count. Stopping at exactly pageSize count would
        // not extract key of last item later and make pagination not work.
        return pageItems.length > pageSize || !lastStartKey;
    }
    let items = await doSearch(ddbApi, TableName, scanParams, 10, onNewItems, operationType);
    let nextKey = null;
    if (items.length > pageSize) {
        items = items.slice(0, pageSize);
        nextKey = extractKey(items[pageSize - 1], keySchema);
    }
    return {
        pageItems: items,
        nextKey,
    };
}

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
async function purgeTable(tableName, ddbApi) {
    const primaryKeys = await findPrimaryKeys(tableName, ddbApi);
    const items = await findAllElements(tableName, primaryKeys, ddbApi);
    await deleteAllElements(tableName, items, ddbApi);
}
async function findPrimaryKeys(tableName, ddbApi) {
    const tableDescription = await ddbApi.describeTable({ TableName: tableName });
    return ['HASH', 'RANGE']
        .map(keyType => tableDescription.KeySchema.find(element => element.KeyType === keyType))
        .filter(attribute => attribute !== undefined)
        .map(attribute => attribute.AttributeName);
}
async function findAllElements(tableName, primaryKeys, ddbApi) {
    const ExpressionAttributeNames = {};
    for (const [index, key] of primaryKeys.entries()) {
        ExpressionAttributeNames[`#KEY${index}`] = key;
    }
    const scanParams = {
        ExpressionAttributeNames,
        ProjectionExpression: Object.keys(ExpressionAttributeNames).join(', '),
    };
    return await doSearch(ddbApi, tableName, scanParams);
}
async function deleteAllElements(tableName, items, ddbApi) {
    const deleteRequests = [];
    let counter = 0;
    const MAX_OPERATIONS = 25;
    const requestItems = {
        [tableName]: [],
    };
    for (const item of items) {
        requestItems[tableName].push({
            DeleteRequest: {
                Key: item,
            },
        });
        counter++;
        if (counter % MAX_OPERATIONS === 0) {
            deleteRequests.push(ddbApi.batchWriteItem({ RequestItems: requestItems }));
            requestItems[tableName] = [];
        }
    }
    if (counter % MAX_OPERATIONS !== 0) {
        deleteRequests.push(ddbApi.batchWriteItem({ RequestItems: requestItems }));
        requestItems[tableName] = [];
    }
    return await Promise.all(deleteRequests);
}

async function listAllTables(ddbApi) {
    const allTableNames = [];
    let lastEvaluatedTableName = undefined;
    do {
        const { LastEvaluatedTableName, TableNames } = await ddbApi.listTables({ ExclusiveStartTableName: lastEvaluatedTableName });
        allTableNames.push(...TableNames || []);
        lastEvaluatedTableName = LastEvaluatedTableName;
    } while (lastEvaluatedTableName !== undefined);
    return await Promise.all(allTableNames.map(tableName => ddbApi.describeTable({ TableName: tableName })));
}

function asyncMiddleware (endpointHandlerFunction) {
    return function (req, res, next) {
        Promise.resolve(endpointHandlerFunction(req, res, next)).catch(next);
    };
}

/**
 * Recursively transform B and BS values in a single DynamoDB attribute.
 */
function transformBinaryAttr(attr, transformB) {
    if (attr == null)
        return attr;
    if (attr.B !== undefined)
        return { B: transformB(attr.B) };
    if (attr.BS)
        return { BS: attr.BS.map(transformB) };
    if (attr.L)
        return { L: attr.L.map((item) => transformBinaryAttr(item, transformB)) };
    if (attr.M)
        return { M: transformBinaryMap(attr.M, transformB) };
    return attr;
}
/**
 * Recursively transform B and BS values in a DynamoDB attribute map.
 */
function transformBinaryMap(attrMap, transformB) {
    const result = {};
    for (const [key, attr] of Object.entries(attrMap)) {
        result[key] = transformBinaryAttr(attr, transformB);
    }
    return result;
}
function bufferToBase64(buf) {
    if (buf instanceof Uint8Array)
        return Buffer.from(buf).toString('base64');
    if (typeof buf === 'string')
        return buf;
    // {type: "Buffer", data: [...]} shape from JSON.stringify(Buffer)
    if (buf && buf.type === 'Buffer' && Array.isArray(buf.data)) {
        return Buffer.from(buf.data).toString('base64');
    }
    return String(buf);
}
function base64ToBuffer(b) {
    return typeof b === 'string' ? Buffer.from(b, 'base64') : b;
}
/**
 * Converts a Document Client item to a DynamoDB attribute map that is safe
 * for native JSON.stringify. Numbers are {"N": "string"}, binary data is base64.
 */
function itemToAttributeMap(item) {
    return transformBinaryMap(utilDynamodb.marshall(item, { removeUndefinedValues: true }), bufferToBase64);
}
/**
 * Converts a DynamoDB attribute map back to a Document Client item.
 * Converts base64 strings in B/BS back to Buffers, then unmarshalls
 * with wrapNumbers so large numbers become NumberValue objects.
 */
function attributeMapToItem(attributeMap) {
    return utilDynamodb.unmarshall(transformBinaryMap(attributeMap, base64ToBuffer), { wrapNumbers: true });
}
/**
 * Express body parser middleware for attribute map JSON bodies.
 * Parses the JSON body with native JSON.parse (safe since attribute maps
 * represent all numbers as strings), then unmarshalls to a Document Client item.
 */
function attributeMapBodyParser(options) {
    return [
        bodyParser.json({ limit: options?.limit ?? '500kb' }),
        (req, _res, next) => {
            if (req.body && typeof req.body === 'object') {
                try {
                    req.body = attributeMapToItem(req.body);
                }
                catch (err) {
                    return next(err);
                }
            }
            next();
        },
    ];
}

const DEFAULT_THEME = process.env.DEFAULT_THEME || 'light';
function setupRoutes(app, ddbApi, basePath = '') {
    const router = express.Router();
    router.use(errorhandler());
    router.use('/assets', express.static(path.join(__dirname, '..', 'public')));
    router.use(cookieParser(), (req, res, next) => {
        const { theme = DEFAULT_THEME } = req.cookies;
        res.locals = {
            theme,
            basePath,
        };
        next();
    });
    router.get('/', asyncMiddleware(async (_req, res) => {
        const data = await listAllTables(ddbApi);
        res.render('tables', { data });
    }));
    router.get('/api/tables', asyncMiddleware(async (_req, res) => {
        const data = await listAllTables(ddbApi);
        res.send(data);
    }));
    router.get('/create-table', (_req, res) => {
        res.render('create-table', {});
    });
    router.post('/create-table', bodyParser.json({ limit: '500kb' }), asyncMiddleware(async (req, res) => {
        const { TableName, HashAttributeName, HashAttributeType, RangeAttributeName, RangeAttributeType, ReadCapacityUnits, WriteCapacityUnits } = req.body.TableDefinition;
        const SecondaryIndexes = req.body.SecondaryIndexes;
        const attributeDefinitions = [
            {
                AttributeName: HashAttributeName,
                AttributeType: HashAttributeType,
            },
        ];
        const keySchema = [
            {
                AttributeName: HashAttributeName,
                KeyType: 'HASH',
            },
        ];
        if (RangeAttributeName) {
            if (!RangeAttributeType) {
                res.status(400).json({ message: `The attribute type of the range attribute "${RangeAttributeName}" is not specified` });
                return;
            }
            attributeDefinitions.push({
                AttributeName: RangeAttributeName,
                AttributeType: RangeAttributeType,
            });
            keySchema.push({
                AttributeName: RangeAttributeName,
                KeyType: 'RANGE',
            });
        }
        const globalSecondaryIndexes = [];
        const localSecondaryIndexes = [];
        if (SecondaryIndexes) {
            for (const secondaryIndex of SecondaryIndexes) {
                const secondaryIndexKeySchema = [
                    {
                        AttributeName: secondaryIndex.HashAttributeName,
                        KeyType: 'HASH',
                    },
                ];
                if (isAttributeNotAlreadyCreated(attributeDefinitions, secondaryIndex.HashAttributeName)) {
                    attributeDefinitions.push({
                        AttributeName: secondaryIndex.HashAttributeName,
                        AttributeType: secondaryIndex.HashAttributeType,
                    });
                }
                if (secondaryIndex.RangeAttributeName) {
                    if (!secondaryIndex.RangeAttributeType) {
                        res.status(400).json({ message: `The attribute type of the range attribute "${secondaryIndex.RangeAttributeName}" is not specified` });
                        return;
                    }
                    if (isAttributeNotAlreadyCreated(attributeDefinitions, secondaryIndex.RangeAttributeName)) {
                        attributeDefinitions.push({
                            AttributeName: secondaryIndex.RangeAttributeName,
                            AttributeType: secondaryIndex.RangeAttributeType,
                        });
                    }
                    secondaryIndexKeySchema.push({
                        AttributeName: secondaryIndex.RangeAttributeName,
                        KeyType: 'RANGE',
                    });
                }
                const index = {
                    IndexName: secondaryIndex.IndexName,
                    KeySchema: secondaryIndexKeySchema,
                    Projection: {
                        ProjectionType: 'ALL',
                    },
                };
                if (secondaryIndex.IndexType === 'global') {
                    globalSecondaryIndexes.push({
                        ...index,
                        ProvisionedThroughput: {
                            ReadCapacityUnits: secondaryIndex.ReadCapacityUnits,
                            WriteCapacityUnits: secondaryIndex.WriteCapacityUnits,
                        },
                    });
                }
                else {
                    localSecondaryIndexes.push(index);
                }
            }
        }
        await ddbApi.createTable({
            TableName,
            ProvisionedThroughput: {
                ReadCapacityUnits,
                WriteCapacityUnits,
            },
            GlobalSecondaryIndexes: globalSecondaryIndexes.length ? globalSecondaryIndexes : undefined,
            LocalSecondaryIndexes: localSecondaryIndexes.length ? localSecondaryIndexes : undefined,
            KeySchema: keySchema,
            AttributeDefinitions: attributeDefinitions,
        });
        res.status(204).end();
    }));
    router.delete('/tables', asyncMiddleware(async (_req, res) => {
        const tablesList = await listAllTables(ddbApi);
        if (tablesList.length === 0) {
            res.send('There are no tables to delete');
            return;
        }
        await Promise.all(tablesList.map(table => ddbApi.deleteTable({ TableName: table.TableName })));
        res.send('Tables deleted');
    }));
    router.delete('/tables-purge', asyncMiddleware(async (req, res) => {
        const tablesList = await listAllTables(ddbApi);
        if (tablesList.length === 0) {
            res.send('There are no tables to purge');
            return;
        }
        await Promise.all(tablesList.map(table => purgeTable(table.TableName, ddbApi)));
        res.send('Tables purged');
    }));
    router.delete('/tables/:TableName', asyncMiddleware(async (req, res) => {
        const { TableName } = req.params;
        await ddbApi.deleteTable({ TableName });
        res.status(204).end();
    }));
    router.delete('/tables/:TableName/all', asyncMiddleware(async (req, res) => {
        const { TableName } = req.params;
        await purgeTable(TableName, ddbApi);
        res.status(200).end();
    }));
    router.get('/tables/:TableName/get', asyncMiddleware(async (req, res) => {
        const { TableName } = req.params;
        const hash = req.query.hash;
        const range = req.query.range;
        if (hash) {
            if (range) {
                res.redirect(`${basePath}/tables/${encodeURIComponent(TableName)}/items/${encodeURIComponent(hash)},${encodeURIComponent(range)}`);
            }
            else {
                res.redirect(`${basePath}/tables/${encodeURIComponent(TableName)}/items/${encodeURIComponent(hash)}`);
            }
            return;
        }
        const description = await ddbApi.describeTable({ TableName });
        const hashKey = description.KeySchema.find(schema => schema.KeyType === 'HASH');
        const rangeKey = description.KeySchema.find(schema => schema.KeyType === 'RANGE');
        res.render('get', {
            Table: description,
            hashKey,
            rangeKey,
        });
    }));
    router.get('/tables/:TableName', asyncMiddleware(async (req, res) => {
        const TableName = req.params.TableName;
        req.query = pickBy(req.query);
        const pageNum = typeof req.query.pageNum === 'string' ? Number.parseInt(req.query.pageNum) : 1;
        const description = await ddbApi.describeTable({ TableName });
        const data = {
            query: req.query,
            pageNum,
            operators: {
                '=': '=',
                '<>': '≠',
                '>=': '>=',
                '<=': '<=',
                '>': '>',
                '<': '<',
                begins_with: 'begins_with',
            },
            attributeTypes: {
                S: 'String',
                N: 'Number',
            },
            Table: description,
        };
        res.render('scan', data);
    }));
    router.get('/tables/:TableName/items', asyncMiddleware(async (req, res) => {
        const { TableName } = req.params;
        req.query = pickBy(req.query);
        const filters = typeof req.query.filters === 'string' ? JSON.parse(req.query.filters) : {};
        const ExclusiveStartKey = typeof req.query.startKey === 'string' ? attributeMapToItem(JSON.parse(req.query.startKey)) : {};
        const pageNum = typeof req.query.pageNum === 'string' ? parseInt(req.query.pageNum) : 1;
        const queryableSelection = typeof req.query.queryableSelection === 'string' ? req.query.queryableSelection : 'table';
        const operationType = req.query.operationType === 'query' ? 'query' : 'scan';
        let indexBeingUsed = null;
        const tableDescription = await ddbApi.describeTable({ TableName });
        if (operationType === 'query') {
            if (queryableSelection === 'table') {
                indexBeingUsed = tableDescription;
            }
            else if (tableDescription.GlobalSecondaryIndexes) {
                indexBeingUsed = tableDescription.GlobalSecondaryIndexes.find(index => index.IndexName === req.query.queryableSelection);
            }
        }
        const ExpressionAttributeNames = {};
        const ExpressionAttributeValues = {};
        const FilterExpressions = [];
        const KeyConditionExpression = [];
        let i = 0;
        for (const key in filters) {
            if (filters[key].type === 'N') {
                filters[key].value = safeNumber(filters[key].value);
            }
            ExpressionAttributeNames[`#key${i}`] = key;
            ExpressionAttributeValues[`:key${i}`] = filters[key].value;
            const matchedKeySchema = indexBeingUsed
                ? indexBeingUsed.KeySchema.find(keySchemaItem => keySchemaItem.AttributeName === key)
                : undefined;
            if (matchedKeySchema) {
                if (matchedKeySchema.KeyType === 'RANGE' && filters[key].operator === 'begins_with') {
                    KeyConditionExpression.push(`${filters[key].operator} ( #key${i} , :key${i})`);
                }
                else {
                    KeyConditionExpression.push(`#key${i} ${filters[key].operator} :key${i}`);
                }
            }
            else {
                if (filters[key].operator === 'begins_with') {
                    FilterExpressions.push(`${filters[key].operator} ( #key${i} , :key${i})`);
                }
                else {
                    FilterExpressions.push(`#key${i} ${filters[key].operator} :key${i}`);
                }
            }
            i = i + 1;
        }
        const params = {
            FilterExpression: FilterExpressions.length ? FilterExpressions.join(' AND ') : undefined,
            ExclusiveStartKey: Object.keys(ExclusiveStartKey).length ? ExclusiveStartKey : undefined,
            ExpressionAttributeNames: Object.keys(ExpressionAttributeNames).length ? ExpressionAttributeNames : undefined,
            ExpressionAttributeValues: Object.keys(ExpressionAttributeValues).length ? ExpressionAttributeValues : undefined,
            KeyConditionExpression: KeyConditionExpression.length ? KeyConditionExpression.join(' AND ') : undefined,
            IndexName: queryableSelection !== 'table' ? queryableSelection : undefined,
        };
        const pageSize = typeof req.query.pageSize === 'string' ? Number.parseInt(req.query.pageSize) : 25;
        const results = await getPage(ddbApi, tableDescription.KeySchema, TableName, params, pageSize, operationType);
        const { pageItems, nextKey } = results;
        const primaryKeys = tableDescription.KeySchema.map(schema => schema.AttributeName);
        // Primary keys are listed first.
        const uniqueKeys = [
            ...primaryKeys,
            ...extractKeysForItems(pageItems).filter(key => !primaryKeys.includes(key)),
        ];
        // Append the item key and convert items to attribute maps for the browser.
        const marshalledItems = pageItems.map(item => {
            const marshalled = itemToAttributeMap(item);
            const keyAttrs = {};
            for (const schema of tableDescription.KeySchema) {
                if (schema.AttributeName && marshalled[schema.AttributeName]) {
                    keyAttrs[schema.AttributeName] = marshalled[schema.AttributeName];
                }
            }
            marshalled.__key = { M: keyAttrs };
            return marshalled;
        });
        const data = {
            query: req.query,
            pageNum,
            prevKey: encodeURIComponent(typeof req.query.prevKey === 'string' ? req.query.prevKey : ''),
            startKey: encodeURIComponent(typeof req.query.startKey === 'string' ? req.query.startKey : ''),
            nextKey: nextKey ? encodeURIComponent(JSON.stringify(itemToAttributeMap(nextKey))) : null,
            filterQueryString: encodeURIComponent(typeof req.query.filters === 'string' ? req.query.filters : ''),
            Table: tableDescription,
            Items: marshalledItems,
            uniqueKeys,
        };
        res.json(data);
    }));
    router.get('/tables/:TableName/meta', asyncMiddleware(async (req, res) => {
        const { TableName } = req.params;
        const [tableDescription, items] = await Promise.all([
            ddbApi.describeTable({ TableName }),
            ddbApi.scan({ TableName }),
        ]);
        const data = {
            Table: tableDescription,
            ...items,
        };
        res.render('meta', data);
    }));
    router.delete('/tables/:TableName/items/:key', asyncMiddleware(async (req, res) => {
        const { TableName } = req.params;
        const tableDescription = await ddbApi.describeTable({ TableName });
        await ddbApi.deleteItem({
            TableName,
            Key: parseKey(req.params.key, tableDescription),
        });
        res.status(204).end();
    }));
    router.get('/tables/:TableName/add-item', asyncMiddleware(async (req, res) => {
        const { TableName } = req.params;
        const tableDescription = await ddbApi.describeTable({ TableName });
        const Item = {};
        for (const key of tableDescription.KeySchema) {
            if (!key.AttributeName || !tableDescription.AttributeDefinitions) {
                continue;
            }
            const definition = tableDescription.AttributeDefinitions.find(attribute => attribute.AttributeName === key.AttributeName);
            if (!definition) {
                continue;
            }
            Item[key.AttributeName] = definition.AttributeType === 'S' ? '' : 0;
        }
        res.render('item', {
            Table: tableDescription,
            TableName: req.params.TableName,
            Item: itemToAttributeMap(Item),
            isNew: true,
        });
    }));
    router.get('/tables/:TableName/items/:key', asyncMiddleware(async (req, res) => {
        const { TableName } = req.params;
        const tableDescription = await ddbApi.describeTable({ TableName });
        const params = {
            TableName,
            Key: parseKey(req.params.key, tableDescription),
        };
        const response = await ddbApi.getItem(params);
        if (!response.Item) {
            res.status(404).send('Not found');
            return;
        }
        res.render('item', {
            Table: tableDescription,
            TableName: req.params.TableName,
            Item: itemToAttributeMap(response.Item),
            isNew: false,
        });
    }));
    router.put('/tables/:TableName/add-item', ...attributeMapBodyParser({ limit: '500kb' }), asyncMiddleware(async (req, res) => {
        const { TableName } = req.params;
        const tableDescription = await ddbApi.describeTable({ TableName });
        await ddbApi.putItem({ TableName, Item: req.body });
        const Key = extractKey(req.body, tableDescription.KeySchema);
        const response = await ddbApi.getItem({ TableName, Key });
        if (!response.Item) {
            res.status(404).send('Not found');
            return;
        }
        res.json(itemToAttributeMap(Key));
        return;
    }));
    router.put('/tables/:TableName/items/:key', ...attributeMapBodyParser({ limit: '500kb' }), asyncMiddleware(async (req, res) => {
        const { TableName } = req.params;
        const tableDescription = await ddbApi.describeTable({ TableName });
        await ddbApi.putItem({ TableName, Item: req.body });
        const response = await ddbApi.getItem({
            TableName,
            Key: parseKey(req.params.key, tableDescription),
        });
        res.json(itemToAttributeMap(response.Item));
    }));
    router.use(((error, _req, res, _next) => {
        console.info(error.stack);
        res.status(500).json({ message: error.message });
    }));
    app.use(basePath, router);
}

class DynamoApiController {
    dynamodb;
    docClient;
    constructor(dynamodb) {
        this.dynamodb = dynamodb;
        this.docClient = libDynamodb.DynamoDBDocumentClient.from(dynamodb, {
            unmarshallOptions: { wrapNumbers: true },
        });
    }
    async batchWriteItem(input) {
        return await this.dynamodb.send(new libDynamodb.BatchWriteCommand(input));
    }
    async createTable(input) {
        return await this.dynamodb.send(new clientDynamodb.CreateTableCommand(input));
    }
    async deleteItem(input) {
        return await this.docClient.send(new libDynamodb.DeleteCommand(input));
    }
    async deleteTable(input) {
        return await this.dynamodb.send(new clientDynamodb.DeleteTableCommand(input));
    }
    async describeTable(input) {
        const description = await this.dynamodb.send(new clientDynamodb.DescribeTableCommand(input));
        if (!description.Table) {
            throw new DynamoDBAdminError(`No table named ${input.TableName}`);
        }
        return description.Table;
    }
    async listTables(input) {
        return await this.dynamodb.send(new clientDynamodb.ListTablesCommand(input));
    }
    async query(input) {
        return await this.docClient.send(new libDynamodb.QueryCommand(input));
    }
    async scan(input) {
        return await this.docClient.send(new libDynamodb.ScanCommand(input));
    }
    async getItem(input) {
        return await this.docClient.send(new libDynamodb.GetCommand(input));
    }
    async putItem(input) {
        return await this.docClient.send(new libDynamodb.PutCommand(input));
    }
}

function createServer(options) {
    const { dynamoDbClient, expressInstance, dynamoEndpoint, skipDefaultCredentials, basePath = '' } = options || {};
    const app = expressInstance || express();
    let dynamodb = dynamoDbClient;
    app.set('json spaces', 2);
    app.set('view engine', 'ejs');
    app.set('views', path.resolve(__dirname, '..', 'views'));
    if (!dynamodb) {
        dynamodb = new clientDynamodb.DynamoDBClient(createAwsConfig({ dynamoEndpoint, skipDefaultCredentials }));
    }
    const ddbApi = new DynamoApiController(dynamodb);
    setupRoutes(app, ddbApi, basePath);
    return app;
}

exports.createServer = createServer;
