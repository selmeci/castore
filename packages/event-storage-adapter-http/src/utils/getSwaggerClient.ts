import { OpenAPI } from 'openapi-types';
import _SwaggerClient from 'swagger-client';

import { SwaggerClient } from './types';

export const getSwaggerClient = async ({
  swagger,
}: {
  swagger: OpenAPI.Document;
}): Promise<SwaggerClient> => new _SwaggerClient({ swagger });
