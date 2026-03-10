import moment from 'moment';
import config from './config';
import ManifoldServer from './src/server';
import { TelemetryController } from './src/telemetry-controller';

moment.updateLocale('en', {
  relativeTime: {
    future: 'in %s',
    past: '%s ago',
    s: 'seconds',
    m: '1 minute',
    mm: '%d minutes',
    h: '1 hour',
    hh: '%d hours',
    d: '1 day',
    dd: '%d days',
    M: '1 month',
    MM: '%d months',
    y: '1 year',
    yy: '%d years',
  },
});

// Initialize telemetry controller with config and CLI flags
// This must be done before creating the server to ensure hooks are properly configured
const telemetryController = TelemetryController.getInstance();
telemetryController.initialize(config.telemetry);

new ManifoldServer(config);
