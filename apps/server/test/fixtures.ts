import sharp from 'sharp';

export const renderContract = {
  name: 'render',
  version: 1,
  description: 'Render frames with Cycles.',
  inputs: { scene: { extensions: ['.blend'], max_mb: 1 } },
  params: {
    type: 'object', additionalProperties: false, required: ['frame_start'],
    properties: { frame_start: { type: 'integer', minimum: 0 }, samples: { type: 'integer', minimum: 1, default: 128 } },
  },
  max_runtime_s: 3600,
};
export const transcribeContract = {
  name: 'transcribe',
  version: 1,
  description: 'Speech to text.',
  inputs: { audio: { extensions: ['.wav', '.mp3'], max_mb: 1 } },
  params: { type: 'object', additionalProperties: false, properties: { diarize: { type: 'boolean', default: false } } },
  max_runtime_s: 3600,
};

/** A type without inputs, shaped like the lease pack. */
export const leaseContract = {
  name: 'lease',
  version: 1,
  description: 'Hold the GPU for a program on the worker PC.',
  inputs: {},
  params: {
    type: 'object', additionalProperties: false, required: ['minutes'],
    properties: { minutes: { type: 'integer', minimum: 1, maximum: 720 } },
  },
  max_runtime_s: 43_500,
};

/** Real (tiny) images, for outputs whose content does not matter: the server decodes them for previews without a warning. */
export const TINY_PNG = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 128, b: 255 } } }).png().toBuffer();
export const TINY_JPEG = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 128, b: 0 } } }).jpeg().toBuffer();
