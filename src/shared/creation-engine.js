import './event-model.js';
import '../../creation-engine.js';

const CreationEngine = globalThis.CreationEngine;

if (!CreationEngine) {
  throw new Error('CreationEngine failed to initialize from legacy module.');
}

export default CreationEngine;
