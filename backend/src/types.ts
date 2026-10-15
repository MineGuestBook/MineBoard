import { ObjectId } from 'mongodb';

export interface User {
  _id?: ObjectId;
  email: string;
  password_hash?: string | null;
  auth_provider: 'local' | 'google' | 'apple';
  auth_provider_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProfileThemeConfig {
  background_color?: string;
  card_background?: string;
  text_color?: string;
  accent_color?: string;
  font_family?: string;
  [key: string]: unknown;
}

export interface Profile {
  _id?: ObjectId;
  user_id: ObjectId;
  username: string;
  display_name: string;
  bio?: string;
  avatar_url?: string;
  theme_config?: ProfileThemeConfig;
  created_at: Date;
  updated_at: Date;
}

export interface Comment {
  _id?: ObjectId;
  profile_id: ObjectId;
  author_name: string;
  author_email?: string;
  content: string;
  ip_hash: string;
  likes_count: number;
  liked_by: string[]; // array de origin_fingerprints para unicidade sem lock
  created_at: Date;
}

export interface Session {
  _id: string; // Token de sessão
  user_id: ObjectId;
  expires_at: Date;
  created_at: Date;
}

export interface PasswordResetToken {
  _id?: ObjectId;
  user_id: ObjectId;
  token_hash: string;
  expires_at: Date;
  used_at?: Date | null;
  created_at: Date;
}
