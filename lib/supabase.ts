import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Detection = {
  id: string;
  user_id: string;
  original_text: string;
  ai_score: number;
  human_score: number;
  created_at: string;
};

export type Rephrase = {
  id: string;
  detection_id: string;
  user_id: string;
  rephrased_text: string;
  ai_score: number;
  human_score: number;
  created_at: string;
};
