import sharp from 'sharp';
import type { ModelSpec } from './capabilityCatalog';
import type { ModelDownloadSpec } from './modelStore';

/** Experimental-only MobileSAM artifact pair; deliberately excluded from the verified capability catalog. */
export const MOBILE_SAM_ENCODER: ModelSpec = {
  id: 'mobilesam-image-encoder', displayName: 'MobileSAM image encoder (experimental)', repoId: 'Acly/MobileSAM',
  filePath: 'mobile_sam_image_encoder.onnx', fileName: 'mobile_sam_image_encoder.onnx', sizeBytes: 28_157_093,
  sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749', license: 'MIT',
  upstreamRepo: 'https://huggingface.co/Acly/MobileSAM', attribution: 'Third-party ONNX export; provenance and redistribution rights unresolved.',
  licenseEvidence: 'readme-claim', provenanceStatus: 'second-hand', licenseFile: '', verified: false,
  inputName: 'input_image', inputDims: [1024, 1024, 3], outputNameIndex: 0, normalize: { rescale: 1, mean: [0, 0, 0], std: [1, 1, 1] }
};
export const MOBILE_SAM_DECODER: ModelSpec = {
  id: 'mobilesam-mask-decoder', displayName: 'MobileSAM mask decoder (experimental)', repoId: 'Acly/MobileSAM',
  filePath: 'sam_mask_decoder_multi.onnx', fileName: 'sam_mask_decoder_multi.onnx', sizeBytes: 16_496_559,
  sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe', license: 'MIT',
  upstreamRepo: 'https://huggingface.co/Acly/MobileSAM', attribution: 'Third-party ONNX export; provenance and redistribution rights unresolved.',
  licenseEvidence: 'readme-claim', provenanceStatus: 'second-hand', licenseFile: '', verified: false,
  inputName: 'image_embeddings', inputDims: [1, 256, 64, 64], outputNameIndex: 0, normalize: { rescale: 1, mean: [0, 0, 0], std: [1, 1, 1] }
};
export const MOBILE_SAM_PAIR: ModelSpec[] = [MOBILE_SAM_ENCODER, MOBILE_SAM_DECODER];
export const MOBILE_SAM_ENCODER_SESSION = 'mobilesam:encoder';
export const MOBILE_SAM_DECODER_SESSION = 'mobilesam:decoder';
export const toModelDownloadSpec = (m: ModelSpec): ModelDownloadSpec => ({ id: m.id, repoId: m.repoId, filePath: m.filePath, fileName: m.fileName, sizeBytes: m.sizeBytes, sha256: m.sha256 });

export interface SamPreparedImage { tensor: Float32Array; width: number; height: number; resizedWidth: number; resizedHeight: number; scale: number }
/** Encoder export consumes transformed RGB HWC floats [0,255], then normalizes/pads internally. */
export async function prepareSamImage(absPath: string): Promise<SamPreparedImage> {
  const { data, info } = await sharp(absPath).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || !info.width || !info.height) throw new Error('MobileSAM 需要可解码的 RGB 图片');
  const scale = 1024 / Math.max(info.width, info.height);
  const resizedWidth = Math.max(1, Math.round(info.width * scale));
  const resizedHeight = Math.max(1, Math.round(info.height * scale));
  const { data: resized } = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).resize(resizedWidth, resizedHeight, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const tensor = new Float32Array(1024 * 1024 * 3);
  for (let y = 0; y < resizedHeight; y++) tensor.set(Float32Array.from(resized.subarray(y * resizedWidth * 3, (y + 1) * resizedWidth * 3)), y * 1024 * 3);
  return { tensor, width: info.width, height: info.height, resizedWidth, resizedHeight, scale };
}
export function mapPromptToSam(prompt: { x: number; y: number }, image: SamPreparedImage): [number, number] {
  return [Math.max(0, Math.min(image.resizedWidth - 1, Math.round(prompt.x * image.scale))), Math.max(0, Math.min(image.resizedHeight - 1, Math.round(prompt.y * image.scale)))];
}
export function selectBestMask(masks: Float32Array, dims: number[], scores: Float32Array): { data: Float32Array; width: number; height: number } {
  if (dims.length !== 4 || dims[0] !== 1 || dims[1]! < 1) throw new Error(`MobileSAM 输出掩码形状无效：${dims.join('x')}`);
  const count = dims[1]!; const height = dims[2]!; const width = dims[3]!; const area = width * height;
  if (area <= 0 || masks.length < count * area) throw new Error('MobileSAM 输出掩码数据长度无效');
  let chosen = 0; for (let i = 1; i < count; i++) if ((scores[i] ?? -Infinity) > (scores[chosen] ?? -Infinity)) chosen = i;
  return { data: masks.slice(chosen * area, (chosen + 1) * area), width, height };
}
