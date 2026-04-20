/*
  # AI Content Detection System

  ## New Tables
  
  ### `detections`
  - `id` (uuid, primary key) - Unique identifier for each detection
  - `user_id` (uuid) - Reference to auth.users
  - `original_text` (text) - The text that was analyzed
  - `ai_score` (numeric) - AI detection score (0-100)
  - `human_score` (numeric) - Human-like score (0-100)
  - `created_at` (timestamptz) - When the detection was performed
  
  ### `rephrases`
  - `id` (uuid, primary key) - Unique identifier for each rephrase
  - `detection_id` (uuid) - Reference to detections table
  - `user_id` (uuid) - Reference to auth.users
  - `rephrased_text` (text) - The rephrased version
  - `ai_score` (numeric) - AI detection score of rephrased text
  - `human_score` (numeric) - Human-like score of rephrased text
  - `created_at` (timestamptz) - When the rephrase was created

  ## Security
  - Enable RLS on all tables
  - Users can only view and manage their own detections and rephrases
  - Authenticated users can create new detections and rephrases
*/

CREATE TABLE IF NOT EXISTS detections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  original_text text NOT NULL,
  ai_score numeric NOT NULL DEFAULT 0,
  human_score numeric NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rephrases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detection_id uuid REFERENCES detections(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id),
  rephrased_text text NOT NULL,
  ai_score numeric NOT NULL DEFAULT 0,
  human_score numeric NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE detections ENABLE ROW LEVEL SECURITY;
ALTER TABLE rephrases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own detections"
  ON detections FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own detections"
  ON detections FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own detections"
  ON detections FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own rephrases"
  ON rephrases FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own rephrases"
  ON rephrases FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own rephrases"
  ON rephrases FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_detections_user_id ON detections(user_id);
CREATE INDEX IF NOT EXISTS idx_rephrases_user_id ON rephrases(user_id);
CREATE INDEX IF NOT EXISTS idx_rephrases_detection_id ON rephrases(detection_id);