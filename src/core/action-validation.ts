/**
 * Backward-compatible action-validation entry point. The codec tables and
 * implementation live in action-codec.ts so every transport shares one local
 * implementation without a cross-repository runtime or test dependency.
 */
export * from './action-codec';
