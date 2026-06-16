import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  query,
  where,
  Timestamp,
  addDoc,
  serverTimestamp
} from "firebase/firestore";
import { initFirebase } from "./firebase";

export interface Criterion {
  id: string;
  name: string;
  weight: number; // percentage
}

export interface GradingSession {
  id: string;
  name: string;
  createdBy: string;
  createdAt: any;
  criteria: Criterion[];
}

export interface Student {
  id: string;
  name: string;
}

export interface Grade {
  studentId: string;
  teacherId: string;
  teacherName: string;
  scores: { [criterionId: string]: number }; // score out of 100
  totalWeightedScore: number;
  submittedAt: any;
}

export async function createSession(name: string, userId: string): Promise<string | null> {
  const firebase = await initFirebase();
  if (!firebase) return null;
  const { db } = firebase;

  const sessionRef = await addDoc(collection(db, "grading_sessions"), {
    name,
    createdBy: userId,
    createdAt: serverTimestamp(),
    criteria: []
  });

  return sessionRef.id;
}

export async function getSession(sessionId: string): Promise<GradingSession | null> {
  const firebase = await initFirebase();
  if (!firebase) return null;
  const { db } = firebase;

  const docSnap = await getDoc(doc(db, "grading_sessions", sessionId));
  if (docSnap.exists()) {
    return { id: docSnap.id, ...docSnap.data() } as GradingSession;
  }
  return null;
}

export async function updateCriteria(sessionId: string, criteria: Criterion[]): Promise<void> {
  const firebase = await initFirebase();
  if (!firebase) return;
  const { db } = firebase;

  await setDoc(doc(db, "grading_sessions", sessionId), { criteria }, { merge: true });
}

export async function addStudent(sessionId: string, name: string): Promise<void> {
  const firebase = await initFirebase();
  if (!firebase) return;
  const { db } = firebase;

  await addDoc(collection(db, `grading_sessions/${sessionId}/students`), {
    name,
    addedAt: serverTimestamp()
  });
}

export async function getStudents(sessionId: string): Promise<Student[]> {
  const firebase = await initFirebase();
  if (!firebase) return [];
  const { db } = firebase;

  const snap = await getDocs(collection(db, `grading_sessions/${sessionId}/students`));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Student));
}

export async function submitGrade(
  sessionId: string,
  studentId: string,
  teacherId: string,
  teacherName: string,
  scores: { [criterionId: string]: number },
  criteria: Criterion[]
): Promise<void> {
  const firebase = await initFirebase();
  if (!firebase) return;
  const { db } = firebase;

  let totalWeightedScore = 0;
  criteria.forEach(c => {
    totalWeightedScore += (scores[c.id] || 0) * (c.weight / 100);
  });

  const gradeId = `${teacherId}_${studentId}`;
  await setDoc(doc(db, `grading_sessions/${sessionId}/grades`, gradeId), {
    studentId,
    teacherId,
    teacherName,
    scores,
    totalWeightedScore,
    submittedAt: serverTimestamp()
  });
}

export async function getGradingResults(sessionId: string): Promise<{ [studentId: string]: { avgScore: number, teacherCount: number } }> {
  const firebase = await initFirebase();
  if (!firebase) return {};
  const { db } = firebase;

  const snap = await getDocs(collection(db, `grading_sessions/${sessionId}/grades`));
  const grades = snap.docs.map(d => d.data() as Grade);

  const results: { [studentId: string]: { sum: number, count: number } } = {};

  grades.forEach(g => {
    if (!results[g.studentId]) {
      results[g.studentId] = { sum: 0, count: 0 };
    }
    results[g.studentId].sum += g.totalWeightedScore;
    results[g.studentId].count += 1;
  });

  const finalResults: { [studentId: string]: { avgScore: number, teacherCount: number } } = {};
  for (const studentId in results) {
    finalResults[studentId] = {
      avgScore: results[studentId].sum / results[studentId].count,
      teacherCount: results[studentId].count
    };
  }

  return finalResults;
}

export async function getSessions(): Promise<GradingSession[]> {
  const firebase = await initFirebase();
  if (!firebase) return [];
  const { db } = firebase;

  const snap = await getDocs(collection(db, "grading_sessions"));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as GradingSession));
}
