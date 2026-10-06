import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env';

export function hasCloudinaryConfig() {
  return Boolean(
    env.CLOUDINARY_CLOUD_NAME &&
      env.CLOUDINARY_API_KEY &&
      env.CLOUDINARY_API_SECRET,
  );
}

type CloudinaryUploadResult = {
  url: string;
  publicId: string;
  alt?: string;
};

function configureCloudinary() {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error('CLOUDINARY_CONFIG_INVALID');
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  return { cloudName, apiKey, apiSecret };
}

async function uploadToCloudinary(data: Buffer, folder: string, publicId: string, alt?: string): Promise<CloudinaryUploadResult> {
  configureCloudinary();

  return await new Promise<CloudinaryUploadResult>((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        public_id: publicId,
        overwrite: true,
        invalidate: true,
      },
      (error, uploadResult) => {
        if (error) {
          reject(error);
          return;
        }
        if (!uploadResult?.secure_url || !uploadResult.public_id) {
          reject(new Error('CLOUDINARY_UPLOAD_FAILED'));
          return;
        }
        resolve({
          url: uploadResult.secure_url,
          publicId: uploadResult.public_id,
          alt,
        });
      },
    );
    upload.end(data);
  });
}

export async function uploadCoverToCloudinary(data: Buffer, songId: string) {
  return uploadToCloudinary(data, 'music-platform/covers', `song-${songId}`, 'Song cover');
}

export function createCloudinaryAudioUploadSignature(songId: string) {
  const { cloudName, apiKey, apiSecret } = configureCloudinary();
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'music-platform/audio';
  const publicId = `song-${songId}`;
  const overwrite = 'true';
  const signature = cloudinary.utils.api_sign_request({ folder, public_id: publicId, overwrite, timestamp }, apiSecret);
  return { cloudName, apiKey, timestamp, signature, folder, publicId, overwrite };
}

export function cloudinaryAudioUrls(songId: string) {
  const { cloudName } = configureCloudinary();
  const publicId = `music-platform/audio/song-${songId}`;
  return ['64', '128', '192'].map((quality) => ({
    quality,
    url: `https://res.cloudinary.com/${cloudName}/video/upload/br_${quality}k/${publicId}.mp3`,
    publicId,
    mime: 'audio/mpeg',
  }));
}

export function cloudinaryAudioUrl(publicId: string) {
  const { cloudName } = configureCloudinary();
  const encodedPublicId = publicId.split('/').map(encodeURIComponent).join('/');
  return `https://res.cloudinary.com/${cloudName}/video/upload/${encodedPublicId}.mp3`;
}

export async function uploadProfileImageToCloudinary(data: Buffer, userId: string) {
  return uploadToCloudinary(data, 'music-platform/profiles', `user-${userId}`, 'Profile image');
}

export async function uploadBrandLogoToCloudinary(data: Buffer, brandId: string) {
  return uploadToCloudinary(data, 'music-platform/logos', `brand-${brandId}`, 'Brand logo');
}

export async function uploadArtistImageToCloudinary(data: Buffer, artistId: string) {
  return uploadToCloudinary(data, 'music-platform/artists', `artist-${artistId}`, 'Artist image');
}

export async function uploadAlbumCoverToCloudinary(data: Buffer, albumId: string) {
  return uploadToCloudinary(data, 'music-platform/albums', `album-${albumId}`, 'Album cover');
}

export async function uploadCategoryIconToCloudinary(data: Buffer, categoryId: string) {
  return uploadToCloudinary(data, 'music-platform/categories', `category-${categoryId}`, 'Category icon');
}
