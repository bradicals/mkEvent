import '../../event-model.js';

const EventModel = globalThis.EventModel;

if (!EventModel) {
  throw new Error('EventModel failed to initialize from legacy module.');
}

export default EventModel;
