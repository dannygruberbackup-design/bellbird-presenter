const params = new URLSearchParams(location.search);

export const SDK_KEY = params.get('key') ?? '9g41pah9rxt943qd4et9u4crb';

export const MODEL_SID = params.get('m') ?? 'KWbfmeiBanU';

export const IS_DEV = params.has('dev');

export const SHOW_DIAG = params.has('diag') || params.has('dev');

export const RAW_TEXTURE = params.has('raw');

export const CAMERA_SOURCE: 'pose' | 'context' =
  params.get('camera') === 'context' ? 'context' : 'pose';

export const WANT_LIGHTS = params.has('lights');
