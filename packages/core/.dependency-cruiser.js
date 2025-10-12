/** @type {import('dependency-cruiser').IConfiguration} */
import baseConfig from '../../.dependency-cruiser.js';

export default {
  ...baseConfig,
  options: {
    ...baseConfig.options,
    exclude: {
      ...baseConfig.options.exclude,
      path: [
        'src/event/groupedEvent.ts',
        // type dependency only
        'src/connectedEventStore/publishPushedEvent.ts',
      ],
    },
  },
};
