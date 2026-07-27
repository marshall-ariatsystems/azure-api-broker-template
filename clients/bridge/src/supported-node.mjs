// The SEA release build runtime is the minimum supported bridge runtime.
export const SUPPORTED_NODE_MAJOR = 24;
export const SUPPORTED_NODE_ENGINES = '>=24';

export function enginesForMajor(major) {
  return `>=${major}`;
}
