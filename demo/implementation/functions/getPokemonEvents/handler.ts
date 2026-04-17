import type { MiddyfiedHandler } from '@middy/core';

import { EventDetail } from '@castore/core';

import { pokemonsEventStore } from '~/libs/eventStores/pokemons';
import { applyConsoleMiddleware } from '~/libs/middlewares/console';

import { Input, inputSchema } from './schema';

export const getPokemonEvents = async (
  event: Input,
): Promise<{ events: EventDetail[] }> => {
  const {
    queryStringParameters: { aggregateId },
  } = event;

  return pokemonsEventStore.getEvents(aggregateId);
};

type Main = MiddyfiedHandler<Input, { events: EventDetail[] }>;

export const main: Main = applyConsoleMiddleware(getPokemonEvents, {
  inputSchema,
});
