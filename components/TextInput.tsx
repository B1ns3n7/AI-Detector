'use client';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function TextInput({ value, onChange, placeholder, disabled }: TextInputProps) {
  const wordCount = value.trim().split(/\s+/).filter(w => w.length > 0).length;
  const charCount = value.length;

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || "Paste your text here to check for AI-generated content..."}
        disabled={disabled}
        className="w-full h-64 p-4 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none text-gray-800 disabled:bg-gray-100 disabled:cursor-not-allowed transition-all"
      />
      <div className="flex justify-between text-sm text-gray-600">
        <span>{wordCount} words</span>
        <span>{charCount} characters</span>
      </div>
    </div>
  );
}
