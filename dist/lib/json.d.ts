import type { AttributeValue } from '@aws-sdk/client-dynamodb';
/**
 * Converts a Document Client item to a DynamoDB attribute map that is safe
 * for native JSON.stringify. Numbers are {"N": "string"}, binary data is base64.
 */
export declare function itemToAttributeMap(item: Record<string, any>): Record<string, AttributeValue>;
/**
 * Converts a DynamoDB attribute map back to a Document Client item.
 * Converts base64 strings in B/BS back to Buffers, then unmarshalls
 * with wrapNumbers so large numbers become NumberValue objects.
 */
export declare function attributeMapToItem(attributeMap: Record<string, AttributeValue>): Record<string, any>;
/**
 * Express body parser middleware for attribute map JSON bodies.
 * Parses the JSON body with native JSON.parse (safe since attribute maps
 * represent all numbers as strings), then unmarshalls to a Document Client item.
 */
export declare function attributeMapBodyParser(options?: {
    limit?: string;
}): import("connect").NextHandleFunction[];
