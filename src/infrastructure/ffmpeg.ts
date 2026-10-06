import { spawn } from 'node:child_process';
import { env } from '../config/env';
export async function run(binary: string, args: string[], timeout = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Media processing timeout'));
    }, timeout);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 1048576) {
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      settled = true;
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      code === 0 ? resolve(output) : reject(new Error(`Media command failed (${code}): ${errors}`));
    });
  });
}
const inputFlags = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mp3,wav,flac,mov,aac,ogg,matroska,webm',
];
export async function probeAudio(file: string) {
  const info = JSON.parse(
    await run(
      env.FFPROBE_PATH,
      ['-v', 'error', ...inputFlags, '-show_format', '-show_streams', '-of', 'json', file],
      30000,
    ),
  );
  const duration = Number(info.format?.duration);
  if (
    !info.streams?.some((s: any) => s.codec_type === 'audio') ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 14400
  )
    throw new Error('Invalid audio or duration exceeds four hours');
  return duration;
}
export async function transcode(file: string, output: string, quality: string) {
  await run(
    env.FFMPEG_PATH,
    [
      '-nostdin',
      '-v',
      'error',
      ...inputFlags,
      '-i',
      file,
      '-map',
      '0:a:0',
      '-vn',
      '-map_metadata',
      '-1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      `${quality}k`,
      '-ar',
      '44100',
      '-ac',
      '2',
      '-threads',
      '1',
      '-y',
      output,
    ],
    900000,
  );
}
export async function normalizeCover(file: string, output: string) {
  await run(
    env.FFMPEG_PATH,
    [
      '-nostdin',
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-format_whitelist',
      'image2,png_pipe,jpeg_pipe,webp_pipe',
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      'scale=1000:1000:force_original_aspect_ratio=decrease',
      '-map_metadata',
      '-1',
      '-threads',
      '1',
      '-y',
      output,
    ],
    30000,
  );
}
