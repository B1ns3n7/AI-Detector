'use client';

interface DetectionCardProps {
  aiScore: number;
  humanScore: number;
  verdict: string;
  confidence: number;
}

export default function DetectionCard({ aiScore, humanScore, verdict, confidence }: DetectionCardProps) {
  const getScoreColor = (score: number) => {
    if (score > 70) return 'text-red-600';
    if (score > 40) return 'text-yellow-600';
    return 'text-green-600';
  };

  const getProgressColor = (score: number) => {
    if (score > 70) return 'bg-red-500';
    if (score > 40) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  return (
    <div className="bg-white rounded-lg shadow-lg p-6 space-y-4">
      <h3 className="text-xl font-semibold text-gray-800">Detection Results</h3>

      <div className="space-y-4">
        <div>
          <div className="flex justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">AI Score</span>
            <span className={`text-sm font-bold ${getScoreColor(aiScore)}`}>{aiScore}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className={`h-3 rounded-full transition-all duration-500 ${getProgressColor(aiScore)}`}
              style={{ width: `${aiScore}%` }}
            />
          </div>
        </div>

        <div>
          <div className="flex justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Human Score</span>
            <span className={`text-sm font-bold ${getScoreColor(100 - humanScore)}`}>{humanScore}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className={`h-3 rounded-full transition-all duration-500 ${getProgressColor(100 - humanScore)}`}
              style={{ width: `${humanScore}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex justify-between items-center">
          <div>
            <p className="text-sm text-gray-600">Verdict</p>
            <p className={`text-lg font-bold ${getScoreColor(aiScore)}`}>{verdict}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-600">Confidence</p>
            <p className="text-lg font-bold text-gray-800">{Math.round(confidence)}%</p>
          </div>
        </div>
      </div>
    </div>
  );
}
