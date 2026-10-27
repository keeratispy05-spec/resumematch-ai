import { useEffect, useMemo, useRef, useState, type FormEvent, type ChangeEvent, type ReactNode, type DragEvent, type RefObject } from 'react';
import {
  Activity, AlertCircle, ArrowDownUp, ArrowRight, BarChart3, BriefcaseBusiness, Check,
  CheckCircle2, ChevronDown, ChevronRight, CircleHelp, ClipboardCheck,
  Clock3, Download, FileCheck2, FileText, Filter, FolderUp, Gauge,
  LayoutDashboard, ListChecks, LoaderCircle, Plus, RefreshCcw, Search, Settings2,
  ShieldCheck, Sparkles, Target, Trash2, UserRound, UsersRound, X, XCircle,
} from 'lucide-react';
import type { Candidate, CandidateStatus, Criterion, CriterionCategory, Job, Page } from './types';
import { loadDemoData } from './data';
import { loadSaved, saveAll, clearSaved } from './utils/storage';
import { extractBasicFields, reanalyzeCandidate, scoreResume } from './utils/scoring';
import { readPdfText, readScannedPdfWithAi } from './utils/pdf';
import { apiUrl } from './utils/api';

type Toast = { type: 'success' | 'error' | 'info'; message: string };
type UploadTask = { id: string; name: string; state: 'กำลังอ่าน' | 'อ่านสำเร็จ' | 'อ่านไม่สำเร็จ'; message?: string };

const statusLabels: Record<CandidateStatus, string> = {
  pending: 'รอตรวจสอบ', reviewed: 'ตรวจแล้ว', interview: 'นัดสัมภาษณ์', consider: 'พิจารณาเพิ่มเติม', rejected: 'ไม่ดำเนินการต่อ',
};
const statusClasses: Record<CandidateStatus, string> = {
  pending: 'status-pending', reviewed: 'status-reviewed', interview: 'status-interview', consider: 'status-consider', rejected: 'status-rejected',
};
const categories: CriterionCategory[] = ['ทักษะ', 'ประสบการณ์', 'การศึกษา', 'คุณสมบัติอื่น'];
const pageDetails: Record<Page, { label: string; subtitle: string }> = {
  dashboard: { label: 'ภาพรวมระบบ', subtitle: 'ติดตามสถานะการคัดกรองและภาพรวมผู้สมัครของคุณ' },
  candidates: { label: 'ผู้สมัครงาน', subtitle: 'ค้นหา เปรียบเทียบ และตรวจสอบหลักฐานของผู้สมัคร' },
  jobs: { label: 'จัดการตำแหน่งงาน', subtitle: 'กำหนดคุณสมบัติและน้ำหนักเกณฑ์ให้ตรงกับความต้องการของทีม' },
  upload: { label: 'อัปโหลดเรซูเม่', subtitle: 'อ่านข้อความจาก PDF จริงก่อนนำไปวิเคราะห์ตามเกณฑ์' },
  reports: { label: 'รายงาน', subtitle: 'สรุปผลจากข้อมูลที่บันทึกอยู่ในระบบ พร้อมส่งออก CSV' },
};

function uid(prefix = 'id') {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;
}
function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function csvEscape(value: unknown): string {
  const raw = value == null ? '' : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}
function downloadCsv(filename: string, rows: unknown[][]) {
  const csv = '\uFEFF' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function totalWeight(criteria: Criterion[]) {
  return criteria.reduce((sum, criterion) => sum + Number(criterion.weight || 0), 0);
}
function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part.slice(0, 1)).join('') || 'ผู้';
}
function scoreTone(score: number | null) {
  if (score === null) return 'score-muted';
  if (score >= 80) return 'score-good';
  if (score >= 60) return 'score-mid';
  return 'score-low';
}

export default function App() {
  const fallback = useMemo(() => loadDemoData(), []);
  const [jobs, setJobs] = useState<Job[]>(() => loadSaved('resumematch.jobs.v1', fallback.jobs));
  const [candidates, setCandidates] = useState<Candidate[]>(() => loadSaved('resumematch.candidates.v1', fallback.candidates));
  const [page, setPage] = useState<Page>('dashboard');
  const [toast, setToast] = useState<Toast | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [jobModalOpen, setJobModalOpen] = useState(false);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [draftJob, setDraftJob] = useState<Job | null>(null);
  const [searchText, setSearchText] = useState('');
  const [jobFilter, setJobFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [minScoreFilter, setMinScoreFilter] = useState('all');
  const [sortByScore, setSortByScore] = useState(true);
  const [uploadJobId, setUploadJobId] = useState('');
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [databaseStatus, setDatabaseStatus] = useState<'connecting' | 'connected' | 'local-only'>('connecting');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function hydrateFromDatabase() {
      try {
        const response = await fetch(apiUrl('/api/data'));
        if (!response.ok) throw new Error('backend unavailable');
        const payload = await response.json() as { exists?: boolean; jobs?: Job[]; candidates?: Candidate[] };
        if (cancelled) return;
        if (payload.exists && Array.isArray(payload.jobs) && Array.isArray(payload.candidates)) {
          setJobs(payload.jobs);
          setCandidates(payload.candidates);
          saveAll(payload.jobs, payload.candidates);
        } else {
          // First run: migrate the browser's current state (including demo data) into SQLite.
          await fetch(apiUrl('/api/data'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobs, candidates }) });
        }
        setDatabaseStatus('connected');
      } catch {
        if (!cancelled) setDatabaseStatus('local-only');
      } finally {
        if (!cancelled) setServerReady(true);
      }
    }
    void hydrateFromDatabase();
    return () => { cancelled = true; };
    // Hydrate exactly once on app startup; state below is used only for first-run migration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!serverReady) return;
    const saved = saveAll(jobs, candidates);
    if (!saved) setToast({ type: 'error', message: 'พื้นที่จัดเก็บในเบราว์เซอร์ไม่พอ โปรดตรวจสอบพื้นที่จัดเก็บ' });
    if (databaseStatus !== 'connected') return;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(apiUrl('/api/data'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobs, candidates }) });
        if (!response.ok) throw new Error('save failed');
        setDatabaseStatus('connected');
      } catch {
        setDatabaseStatus('local-only');
        setToast({ type: 'error', message: 'เชื่อมต่อฐานข้อมูลไม่ได้ ข้อมูลล่าสุดอาจยังไม่ถูกบันทึกบนเซิร์ฟเวอร์ กรุณาเปิด backend แล้วลองใหม่' });
      }
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [jobs, candidates, serverReady, databaseStatus]);

  useEffect(() => {
    if (toast === null) return;
    const timeout = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!uploadJobId && jobs.length) setUploadJobId(jobs[0].id);
    if (uploadJobId && !jobs.some((job) => job.id === uploadJobId)) setUploadJobId(jobs[0]?.id ?? '');
  }, [jobs, uploadJobId]);

  const selectedCandidate = candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
  const selectedJob = selectedCandidate ? jobs.find((job) => job.id === selectedCandidate.jobId) ?? null : null;
  const demoMode = candidates.some((candidate) => candidate.isDemo) || jobs.some((job) => job.isDemo);
  const unreadableCount = candidates.filter((candidate) => candidate.parseStatus === 'error').length;
  const pendingCount = candidates.filter((candidate) => candidate.status === 'pending').length;
  const baselineCount = candidates.filter((candidate) => candidate.score !== null && candidate.score >= 70 && candidate.parseStatus === 'success').length;
  const needsReviewCount = candidates.filter((candidate) => candidate.parseStatus === 'error' || candidate.score === null || (candidate.score !== null && candidate.score < 70)).length;
  const avgScore = candidates.filter((candidate) => candidate.score !== null).length
    ? Math.round(candidates.filter((candidate) => candidate.score !== null).reduce((sum, candidate) => sum + (candidate.score ?? 0), 0) / candidates.filter((candidate) => candidate.score !== null).length)
    : null;

  const filteredCandidates = useMemo(() => {
    let list = candidates.filter((candidate) => {
      const search = searchText.trim().toLocaleLowerCase('th-TH');
      const matchText = !search || candidate.name.toLocaleLowerCase('th-TH').includes(search) || candidate.fileName.toLocaleLowerCase('th-TH').includes(search) || candidate.email.toLocaleLowerCase('th-TH').includes(search);
      const matchJob = jobFilter === 'all' || candidate.jobId === jobFilter;
      const matchStatus = statusFilter === 'all' || candidate.status === statusFilter;
      const matchScore = minScoreFilter === 'all' || (candidate.score !== null && candidate.score >= Number(minScoreFilter));
      return matchText && matchJob && matchStatus && matchScore;
    });
    if (sortByScore) list = [...list].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    return list;
  }, [candidates, searchText, jobFilter, statusFilter, minScoreFilter, sortByScore]);

  function notify(message: string, type: Toast['type'] = 'success') {
    setToast({ message, type });
  }

  function goTo(nextPage: Page) {
    setPage(nextPage);
    setSelectedCandidateId(null);
  }

  function loadSampleData() {
    const sample = loadDemoData();
    const existingDemoJobIds = new Set(jobs.filter((job) => job.isDemo).map((job) => job.id));
    const existingDemoCandidateIds = new Set(candidates.filter((candidate) => candidate.isDemo).map((candidate) => candidate.id));
    const nextJobs = [...jobs, ...sample.jobs.filter((job) => !existingDemoJobIds.has(job.id))];
    const nextCandidates = [...candidates, ...sample.candidates.filter((candidate) => !existingDemoCandidateIds.has(candidate.id))];
    setJobs(nextJobs);
    setCandidates(nextCandidates);
    notify('โหลดข้อมูลตัวอย่างแล้ว — ข้อมูลเหล่านี้ไม่ใช่ผู้สมัครจริง');
  }

  function clearSampleData() {
    const demoCount = candidates.filter((candidate) => candidate.isDemo).length + jobs.filter((job) => job.isDemo).length;
    if (!demoCount) {
      notify('ไม่มีข้อมูลตัวอย่างให้ล้าง', 'info');
      return;
    }
    if (!window.confirm('ลบเฉพาะตำแหน่งงานและผู้สมัครที่เป็นข้อมูลตัวอย่างใช่หรือไม่? ข้อมูลที่สร้างเองจะยังอยู่')) return;
    const demoJobIds = new Set(jobs.filter((job) => job.isDemo).map((job) => job.id));
    setCandidates(candidates.filter((candidate) => !candidate.isDemo && !demoJobIds.has(candidate.jobId)));
    setJobs(jobs.filter((job) => !job.isDemo));
    setSelectedForCompare([]);
    notify('ล้างข้อมูลตัวอย่างแล้ว');
  }

  function resetExperiment() {
    if (!window.confirm('รีเซ็ตการทดลองและลบตำแหน่งงาน/ผู้สมัครทั้งหมดจากเบราว์เซอร์นี้ใช่หรือไม่? การกระทำนี้ย้อนกลับไม่ได้')) return;
    setJobs([]);
    setCandidates([]);
    setSelectedForCompare([]);
    setUploadTasks([]);
    clearSaved();
    notify('รีเซ็ตข้อมูลในเบราว์เซอร์แล้ว', 'info');
  }

  function openCreateJob() {
    setEditingJobId(null);
    setDraftJob({
      id: uid('job'), title: '', department: '', description: '', minQualification: '',
      criteria: [
        { id: uid('criterion'), label: 'ทักษะที่ต้องการ', category: 'ทักษะ', keywords: [], weight: 40 },
        { id: uid('criterion'), label: 'ประสบการณ์ที่เกี่ยวข้อง', category: 'ประสบการณ์', keywords: [], weight: 30 },
        { id: uid('criterion'), label: 'การศึกษา', category: 'การศึกษา', keywords: [], weight: 20 },
        { id: uid('criterion'), label: 'คุณสมบัติอื่น', category: 'คุณสมบัติอื่น', keywords: [], weight: 10 },
      ], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), criteriaVersion: 1,
    });
    setJobModalOpen(true);
  }

  function openEditJob(job: Job) {
    setEditingJobId(job.id);
    setDraftJob({ ...job, isDemo: false, criteria: job.criteria.map((criterion) => ({ ...criterion, keywords: [...criterion.keywords] })) });
    setJobModalOpen(true);
  }

  function saveJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftJob) return;
    const weight = totalWeight(draftJob.criteria);
    if (Math.abs(weight - 100) > 0.001) {
      notify(`น้ำหนักเกณฑ์รวมต้องเท่ากับ 100% (ปัจจุบัน ${weight}%)`, 'error');
      return;
    }
    if (draftJob.criteria.some((criterion) => !criterion.label.trim() || !criterion.keywords.some((keyword) => keyword.trim()))) {
      notify('กรุณากรอกชื่อเกณฑ์และคำสำคัญอย่างน้อย 1 คำในทุกเกณฑ์', 'error');
      return;
    }
    const existing = editingJobId ? jobs.find((job) => job.id === editingJobId) : null;
    const savedJob: Job = {
      ...draftJob,
      title: draftJob.title.trim(),
      department: draftJob.department.trim(),
      description: draftJob.description.trim(),
      minQualification: draftJob.minQualification.trim(),
      criteria: draftJob.criteria.map((criterion) => ({ ...criterion, label: criterion.label.trim(), keywords: criterion.keywords.map((keyword) => keyword.trim()).filter(Boolean), weight: Number(criterion.weight) })),
      updatedAt: new Date().toISOString(),
      criteriaVersion: existing ? existing.criteriaVersion + 1 : 1,
      isDemo: false,
    };
    if (existing) {
      setJobs(jobs.map((job) => job.id === existing.id ? savedJob : job));
      setCandidates((previous) => previous.map((candidate) => candidate.jobId === savedJob.id ? reanalyzeCandidate(candidate, savedJob) : candidate));
      notify('บันทึกตำแหน่งงานและวิเคราะห์คะแนนใหม่ตามเกณฑ์ล่าสุดแล้ว');
    } else {
      setJobs([...jobs, savedJob]);
      setUploadJobId(savedJob.id);
      notify('เพิ่มตำแหน่งงานแล้ว');
    }
    setJobModalOpen(false);
    setDraftJob(null);
  }

  function deleteJob(job: Job) {
    const attached = candidates.filter((candidate) => candidate.jobId === job.id).length;
    const message = attached
      ? `ลบตำแหน่ง “${job.title}” และผู้สมัครที่ผูกกับตำแหน่งนี้ ${attached} รายการใช่หรือไม่?`
      : `ลบตำแหน่ง “${job.title}” ใช่หรือไม่?`;
    if (!window.confirm(message)) return;
    setJobs(jobs.filter((item) => item.id !== job.id));
    setCandidates(candidates.filter((candidate) => candidate.jobId !== job.id));
    notify('ลบตำแหน่งงานแล้ว');
  }

  function updateCriterion(index: number, patch: Partial<Criterion>) {
    if (!draftJob) return;
    setDraftJob({ ...draftJob, criteria: draftJob.criteria.map((criterion, current) => current === index ? { ...criterion, ...patch } : criterion) });
  }

  function addCriterion() {
    if (!draftJob) return;
    setDraftJob({ ...draftJob, criteria: [...draftJob.criteria, { id: uid('criterion'), label: '', category: 'ทักษะ', keywords: [], weight: 0 }] });
  }

  function removeCriterion(index: number) {
    if (!draftJob || draftJob.criteria.length <= 1) return;
    setDraftJob({ ...draftJob, criteria: draftJob.criteria.filter((_, current) => current !== index) });
  }

  async function processFiles(fileList: FileList | File[]) {
    if (!uploadJobId) {
      notify('กรุณาสร้างหรือเลือกตำแหน่งงานก่อนอัปโหลด', 'error');
      return;
    }
    const files = Array.from(fileList);
    if (files.length === 0) return;
    const job = jobs.find((item) => item.id === uploadJobId);
    if (!job) {
      notify('ไม่พบตำแหน่งงานที่เลือก กรุณาเลือกใหม่', 'error');
      return;
    }
    if (Math.abs(totalWeight(job.criteria) - 100) > 0.01) {
      notify('น้ำหนักเกณฑ์ของตำแหน่งนี้ไม่ครบ 100% กรุณาแก้ไขก่อนวิเคราะห์', 'error');
      return;
    }
    setUploading(true);
    const tasks = files.map((file) => ({ id: uid('upload'), name: file.name, state: 'กำลังอ่าน' as const }));
    setUploadTasks((current) => [...tasks, ...current]);
    const created: Candidate[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const task = tasks[index];
      try {
        let rawText: string;
        try {
          rawText = await readPdfText(file);
        } catch (pdfError) {
          const parseMessage = pdfError instanceof Error ? pdfError.message : '';
          if (!parseMessage.includes('ภาพสแกน') && !parseMessage.includes('ไม่พบข้อความ')) throw pdfError;
          setUploadTasks((current) => current.map((item) => item.id === task.id ? { ...item, state: 'กำลังอ่าน', message: 'ไม่พบ text layer กำลังลอง OCR ผ่าน AI…' } : item));
          rawText = await readScannedPdfWithAi(file);
        }
        const fields = extractBasicFields(rawText, job.criteria);
        const result = scoreResume(job, rawText);
        const candidate: Candidate = {
          id: uid('candidate'), jobId: job.id,
          name: file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || 'ผู้สมัครใหม่',
          email: fields.email, phone: fields.phone, education: fields.education, experience: fields.experience,
          skills: fields.skills, fileName: file.name, rawText, parseStatus: 'success', score: result.score,
          results: result.results, status: 'pending', analyzedAt: new Date().toISOString(), criteriaVersion: result.version,
        };
        created.push(candidate);
        setUploadTasks((current) => current.map((item) => item.id === task.id ? { ...item, state: 'อ่านสำเร็จ', message: `อ่านข้อความได้ ${rawText.length.toLocaleString('th-TH')} ตัวอักษร` } : item));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'อ่านไฟล์ไม่สำเร็จ กรุณาลองใหม่';
        const candidate: Candidate = {
          id: uid('candidate'), jobId: job.id, name: file.name.replace(/\.pdf$/i, ''), email: '', phone: '', education: '', experience: '', skills: [],
          fileName: file.name, rawText: '', parseStatus: 'error', parseError: message, score: null, results: [], status: 'pending', analyzedAt: null, criteriaVersion: `v${job.criteriaVersion}`,
        };
        created.push(candidate);
        setUploadTasks((current) => current.map((item) => item.id === task.id ? { ...item, state: 'อ่านไม่สำเร็จ', message } : item));
      }
    }
    setCandidates((current) => [...created, ...current]);
    setUploading(false);
    if (created.length) notify(`ประมวลผลไฟล์แล้ว ${created.length} ไฟล์ — โปรดตรวจสอบผลก่อนตัดสินใจ`);
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void processFiles(event.target.files);
    event.target.value = '';
  }

  function changeCandidateStatus(candidateId: string, status: CandidateStatus) {
    setCandidates((current) => current.map((candidate) => candidate.id === candidateId ? { ...candidate, status } : candidate));
    notify(`บันทึกสถานะ: ${statusLabels[status]}`);
  }

  function updateCandidateField(candidateId: string, field: 'name' | 'email' | 'phone' | 'education' | 'experience' | 'skills', value: string) {
    setCandidates((current) => current.map((candidate) => {
      if (candidate.id !== candidateId) return candidate;
      if (field === 'skills') return { ...candidate, skills: value.split(',').map((item) => item.trim()).filter(Boolean) };
      return { ...candidate, [field]: value };
    }));
  }

  function exportCandidates(list: Candidate[] = filteredCandidates) {
    const rows: unknown[][] = [[
      'ชื่อผู้สมัคร', 'อีเมล', 'โทรศัพท์', 'ตำแหน่งงาน', 'คะแนน (%)', 'ทักษะที่ตรง', 'สถานะ HR', 'สถานะอ่าน PDF', 'ไฟล์ต้นฉบับ', 'วันที่วิเคราะห์', 'เวอร์ชันเกณฑ์', 'ข้อมูลตัวอย่าง',
    ]];
    list.forEach((candidate) => rows.push([
      candidate.name, candidate.email, candidate.phone, jobs.find((job) => job.id === candidate.jobId)?.title ?? '', candidate.score ?? '',
      candidate.results.flatMap((result) => result.matchedKeywords).join(' | '), statusLabels[candidate.status], candidate.parseStatus === 'success' ? 'อ่านสำเร็จ' : 'อ่านไม่สำเร็จ',
      candidate.fileName, candidate.analyzedAt ? formatDate(candidate.analyzedAt) : '', candidate.criteriaVersion, candidate.isDemo ? 'ใช่' : 'ไม่ใช่',
    ]));
    downloadCsv('resumematch-candidates.csv', rows);
    notify('ส่งออกไฟล์ CSV แล้ว');
  }

  async function requestAiInsight(candidate: Candidate, job: Job) {
    if (candidate.parseStatus !== 'success' || !candidate.rawText.trim()) {
      notify('ยังไม่มีข้อความเรซูเม่ที่อ่านได้ จึงไม่สามารถขอสรุปจาก AI', 'error');
      return;
    }
    setAiLoading(true);
    try {
      const response = await fetch(apiUrl('/api/ai-insights'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText: candidate.rawText, job }),
      });
      let payload: { insight?: string; error?: string };
      try { payload = await response.json() as { insight?: string; error?: string }; }
      catch { throw new Error('ยังเชื่อมต่อ backend ไม่ได้ เปิด terminal อีกหน้าต่างแล้วรัน npm run server'); }
      if (!response.ok || !payload.insight) throw new Error(payload.error || 'เรียกใช้งาน AI ไม่สำเร็จ');
      setCandidates((current) => current.map((item) => item.id === candidate.id ? { ...item, aiInsight: payload.insight } : item));
      notify('ได้รับสรุปจาก AI แล้ว — ตรวจสอบหลักฐานอีกครั้งก่อนใช้งาน');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ไม่สามารถเชื่อมต่อ AI ได้';
      notify(message, 'error');
    } finally {
      setAiLoading(false);
    }
  }

  function toggleCompare(id: string) {
    setSelectedForCompare((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 4 ? [...current, id] : (notify('เปรียบเทียบได้สูงสุด 4 คน', 'info'), current));
  }

  const compareCandidates = candidates.filter((candidate) => selectedForCompare.includes(candidate.id));
  const activeCandidateStatusCounts = useMemo(() => ({
    pending: candidates.filter((candidate) => candidate.status === 'pending').length,
    reviewed: candidates.filter((candidate) => candidate.status === 'reviewed').length,
    interview: candidates.filter((candidate) => candidate.status === 'interview').length,
    consider: candidates.filter((candidate) => candidate.status === 'consider').length,
    rejected: candidates.filter((candidate) => candidate.status === 'rejected').length,
  }), [candidates]);
  const frequentSkills = useMemo(() => {
    const counts = new Map<string, number>();
    candidates.filter((candidate) => candidate.parseStatus === 'success').forEach((candidate) => {
      candidate.results.forEach((result) => result.matchedKeywords.forEach((keyword) => counts.set(keyword, (counts.get(keyword) ?? 0) + 1)));
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [candidates]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><Sparkles size={21} strokeWidth={2.2} /></div>
          <div><div className="brand-name">ResumeMatch <span>AI</span></div><div className="brand-caption">TALENT WORKSPACE</div></div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="เมนูหลัก">
          <button className={`nav-item ${page === 'dashboard' ? 'active' : ''}`} onClick={() => goTo('dashboard')}><LayoutDashboard size={19} /><span>ภาพรวมระบบ</span>{page === 'dashboard' && <span className="nav-active-dot" />}</button>
          <button className={`nav-item ${page === 'candidates' ? 'active' : ''}`} onClick={() => goTo('candidates')}><UsersRound size={19} /><span>ผู้สมัครงาน</span><span className="nav-count">{candidates.length}</span></button>
          <button className={`nav-item ${page === 'jobs' ? 'active' : ''}`} onClick={() => goTo('jobs')}><BriefcaseBusiness size={19} /><span>ตำแหน่งงาน</span><span className="nav-count">{jobs.length}</span></button>
          <button className={`nav-item ${page === 'upload' ? 'active' : ''}`} onClick={() => goTo('upload')}><FolderUp size={19} /><span>อัปโหลดเรซูเม่</span></button>
          <button className={`nav-item ${page === 'reports' ? 'active' : ''}`} onClick={() => goTo('reports')}><BarChart3 size={19} /><span>รายงาน</span></button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-safety">
          <div className="safety-icon"><ShieldCheck size={18} /></div>
          <div><strong>Human-in-the-loop</strong><p>AI ช่วยสรุปข้อมูล แต่ HR เป็นผู้ตัดสินใจทุกครั้ง</p></div>
        </div>
        <div className="profile-row"><div className="profile-avatar">HR</div><div className="profile-name"><strong>ทีมทรัพยากรบุคคล</strong><span>พื้นที่ทำงานส่วนตัว</span></div><button className="icon-button tiny" aria-label="ตั้งค่าข้อมูล" onClick={() => notify('ข้อมูล MVP เก็บในเบราว์เซอร์นี้ ยังไม่มีระบบบัญชีผู้ใช้', 'info')}><Settings2 size={17} /></button></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={15} /><strong>{pageDetails[page].label}</strong></div>
          <div className="topbar-actions">
            <span className={`mode-pill ${demoMode ? 'demo-pill' : 'local-pill'}`}><span className="mode-dot" />{demoMode ? 'มีข้อมูลตัวอย่าง' : 'ข้อมูลในเครื่อง'}</span>
            <button className="button button-quiet button-small hide-mobile" onClick={loadSampleData}><RefreshCcw size={15} /> โหลดข้อมูลตัวอย่าง</button>
            <button className="icon-button reset-experiment-button" title="รีเซ็ตการทดลอง" aria-label="รีเซ็ตการทดลองและลบข้อมูลทั้งหมด" onClick={resetExperiment}><Trash2 size={16} /></button>
            <button className="button button-primary button-small" onClick={() => goTo('upload')}><Plus size={16} /> เพิ่มเรซูเม่</button>
          </div>
        </header>

        <div className="page-container">
          <div className="page-heading">
            <div><div className="eyebrow">HR INTELLIGENCE / 01</div><h1>{pageDetails[page].label}</h1><p>{pageDetails[page].subtitle}</p></div>
            {page === 'jobs' && <button className="button button-primary" onClick={openCreateJob}><Plus size={17} /> เพิ่มตำแหน่งงาน</button>}
            {page === 'candidates' && <button className="button button-primary" onClick={() => goTo('upload')}><FolderUp size={17} /> อัปโหลดเรซูเม่</button>}
          </div>

          {demoMode && <div className="demo-notice"><div className="notice-symbol"><CircleHelp size={17} /></div><div><strong>กำลังแสดงข้อมูลตัวอย่าง</strong><span>ชื่อและเรซูเม่ในระบบเป็นข้อมูลสมมติ ใช้สำหรับสาธิตเท่านั้น</span></div><button className="text-button" onClick={clearSampleData}>ล้างข้อมูลตัวอย่าง</button></div>}

          {page === 'dashboard' && <DashboardPage
            candidates={candidates} jobs={jobs} pendingCount={pendingCount} baselineCount={baselineCount} needsReviewCount={needsReviewCount}
            avgScore={avgScore} unreadableCount={unreadableCount} frequentSkills={frequentSkills} statusCounts={activeCandidateStatusCounts}
            onNavigate={goTo} onOpenCandidate={setSelectedCandidateId} onLoadDemo={loadSampleData} onReset={resetExperiment}
          />}

          {page === 'jobs' && <JobsPage jobs={jobs} candidates={candidates} onCreate={openCreateJob} onEdit={openEditJob} onDelete={deleteJob} onUpload={(jobId) => { setUploadJobId(jobId); goTo('upload'); }} />}

          {page === 'upload' && <UploadPage jobs={jobs} uploadJobId={uploadJobId} setUploadJobId={setUploadJobId} uploadTasks={uploadTasks} uploading={uploading}
            dragActive={dragActive} setDragActive={setDragActive} fileInputRef={fileInputRef} onFileInput={onFileInput} onProcessFiles={processFiles} onGoJobs={() => { goTo('jobs'); openCreateJob(); }} />}

          {page === 'candidates' && <CandidatesPage
            candidates={filteredCandidates} allCandidates={candidates} jobs={jobs} searchText={searchText} setSearchText={setSearchText} jobFilter={jobFilter} setJobFilter={setJobFilter}
            statusFilter={statusFilter} setStatusFilter={setStatusFilter} minScoreFilter={minScoreFilter} setMinScoreFilter={setMinScoreFilter} sortByScore={sortByScore} setSortByScore={setSortByScore}
            selectedForCompare={selectedForCompare} toggleCompare={toggleCompare} setCompareOpen={setCompareOpen} onOpenCandidate={setSelectedCandidateId} onExport={exportCandidates} onUpload={() => goTo('upload')} />}

          {page === 'reports' && <ReportsPage jobs={jobs} candidates={candidates} onExport={exportCandidates} />}
        </div>
        <footer className="footer-note"><span><ShieldCheck size={14} /> ข้อมูลจัดเก็บในเบราว์เซอร์นี้</span><span>ResumeMatch AI <b>•</b> MVP 1.0</span></footer>
      </main>

      {jobModalOpen && draftJob && <JobModal draftJob={draftJob} editing={Boolean(editingJobId)} onClose={() => setJobModalOpen(false)} onSave={saveJob} onChange={(patch) => setDraftJob({ ...draftJob, ...patch })} onUpdateCriterion={updateCriterion} onAddCriterion={addCriterion} onRemoveCriterion={removeCriterion} />}
      {selectedCandidate && selectedJob && <CandidateModal candidate={selectedCandidate} job={selectedJob} onClose={() => setSelectedCandidateId(null)} onChangeField={updateCandidateField} onChangeStatus={changeCandidateStatus} onRequestAi={() => void requestAiInsight(selectedCandidate, selectedJob)} aiLoading={aiLoading} />}
      {compareOpen && <CompareModal candidates={compareCandidates} jobs={jobs} onClose={() => setCompareOpen(false)} onOpenCandidate={(id) => { setCompareOpen(false); setSelectedCandidateId(id); }} />}
      {toast && <div className={`toast toast-${toast.type}`} role="status"><div className="toast-icon">{toast.type === 'success' ? <CheckCircle2 size={18} /> : toast.type === 'error' ? <XCircle size={18} /> : <AlertCircle size={18} />}</div><span>{toast.message}</span><button aria-label="ปิดข้อความ" onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  );
}

function DashboardPage({
  candidates, jobs, pendingCount, baselineCount, needsReviewCount, avgScore, unreadableCount, frequentSkills, statusCounts, onNavigate, onOpenCandidate, onLoadDemo, onReset,
}: {
  candidates: Candidate[]; jobs: Job[]; pendingCount: number; baselineCount: number; needsReviewCount: number; avgScore: number | null; unreadableCount: number;
  frequentSkills: [string, number][]; statusCounts: Record<CandidateStatus, number>; onNavigate: (page: Page) => void; onOpenCandidate: (id: string) => void; onLoadDemo: () => void; onReset: () => void;
}) {
  const recent = [...candidates].sort((a, b) => (b.analyzedAt ?? '').localeCompare(a.analyzedAt ?? '')).slice(0, 5);
  const maxSkill = Math.max(1, ...frequentSkills.map(([, count]) => count));
  const distribution = [
    { label: '80–100%', count: candidates.filter((candidate) => candidate.score !== null && candidate.score >= 80).length, className: 'bar-high' },
    { label: '60–79%', count: candidates.filter((candidate) => candidate.score !== null && candidate.score >= 60 && candidate.score < 80).length, className: 'bar-mid' },
    { label: '0–59%', count: candidates.filter((candidate) => candidate.score !== null && candidate.score < 60).length, className: 'bar-low' },
    { label: 'ยังไม่มีคะแนน', count: candidates.filter((candidate) => candidate.score === null).length, className: 'bar-null' },
  ];
  const maxDistribution = Math.max(1, ...distribution.map((row) => row.count));
  return <>
    <section className="welcome-banner">
      <div className="welcome-copy"><div className="welcome-kicker"><span className="pulse-dot" /> SMART TALENT REVIEW</div><h2>คัดกรองได้เป็นระบบ<br />ตัดสินใจด้วยหลักฐาน</h2><p>เปรียบเทียบเรซูเม่กับคุณสมบัติตำแหน่งงาน โดยมีเกณฑ์ที่อธิบายได้และให้ HR ตรวจสอบทุกครั้ง</p><div className="welcome-actions"><button className="button button-light" onClick={() => onNavigate('upload')}><FolderUp size={17} /> เริ่มอัปโหลดเรซูเม่ <ArrowRight size={16} /></button><button className="welcome-text-button" onClick={() => onNavigate('jobs')}>จัดการเกณฑ์ตำแหน่งงาน <ChevronRight size={15} /></button></div></div>
      <div className="welcome-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-card art-main"><div className="art-card-head"><div className="art-avatar"><UserRound size={18} /></div><div><span>Resume match</span><strong>วิเคราะห์ตามเกณฑ์</strong></div><span className="art-check"><Check size={14} /></span></div><div className="art-score-row"><div><small>คะแนนเฉลี่ยจริง</small><strong>{avgScore === null ? '—' : avgScore}<span>{avgScore === null ? '' : '/100'}</span></strong></div><div className="art-mini-ring"><span>{avgScore === null ? '—' : `${avgScore}%`}</span></div></div><div className="art-line"><span style={{ width: `${avgScore ?? 0}%` }} /><i /></div><div className="art-line short"><span /><i /></div><div className="art-tags"><b>React</b><b>TypeScript</b><b>+2</b></div></div><div className="art-float"><Sparkles size={15} /><span>Evidence-based</span></div></div>
    </section>

    <div className="section-heading"><div><h2>ภาพรวมการคัดกรอง</h2><p>อัปเดตจากรายการผู้สมัครทั้งหมดในระบบ</p></div><button className="text-button" onClick={() => onNavigate('reports')}>ดูรายงานทั้งหมด <ArrowRight size={14} /></button></div>
    <section className="stats-grid">
      <StatCard icon={<UsersRound size={19} />} title="ผู้สมัครทั้งหมด" value={candidates.length} note="ทุกตำแหน่งงาน" tone="green" onClick={() => onNavigate('candidates')} />
      <StatCard icon={<Clock3 size={19} />} title="รอตรวจสอบ" value={pendingCount} note="ต้องการการตรวจจาก HR" tone="amber" onClick={() => onNavigate('candidates')} />
      <StatCard icon={<Target size={19} />} title="คะแนนตั้งแต่ 70%" value={baselineCount} note="ผ่านเกณฑ์เบื้องต้นเท่านั้น" tone="blue" onClick={() => onNavigate('candidates')} />
      <StatCard icon={<AlertCircle size={19} />} title="ต้องตรวจเพิ่มเติม" value={needsReviewCount} note="คะแนนต่ำหรือไม่มีผลอ่าน" tone="rose" onClick={() => onNavigate('candidates')} />
    </section>

    <section className="dashboard-grid">
      <div className="panel score-panel"><div className="panel-heading"><div><h3>การกระจายคะแนน</h3><p>เฉพาะเรซูเม่ที่อ่านและคำนวณคะแนนได้</p></div><div className="panel-icon"><Gauge size={18} /></div></div><div className="distribution-summary"><div className="avg-score"><strong>{avgScore === null ? '—' : avgScore}<small>{avgScore === null ? '' : '%'}</small></strong><span>คะแนนเฉลี่ย</span></div><div className="distribution-bars">{distribution.map((row) => <div className="distribution-row" key={row.label}><span>{row.label}</span><div className="distribution-track"><div className={`distribution-fill ${row.className}`} style={{ width: `${(row.count / maxDistribution) * 100}%` }} /></div><strong>{row.count}</strong></div>)}</div></div><div className="panel-footnote"><ShieldCheck size={14} /> คะแนนคำนวณจากคำสำคัญและน้ำหนักเกณฑ์ ไม่ใช่คะแนนที่ AI สุ่มสร้าง</div></div>
      <div className="panel skills-panel"><div className="panel-heading"><div><h3>ทักษะที่พบตามเกณฑ์</h3><p>นับจากคำสำคัญที่ตรงกับเกณฑ์แต่ละตำแหน่ง</p></div><div className="panel-icon"><Activity size={18} /></div></div>{frequentSkills.length ? <div className="skill-rank-list">{frequentSkills.slice(0, 6).map(([skill, count], index) => <div className="skill-rank" key={skill}><span className="skill-rank-no">{String(index + 1).padStart(2, '0')}</span><span className="skill-rank-name">{skill}</span><div className="skill-rank-track"><div style={{ width: `${(count / maxSkill) * 100}%` }} /></div><strong>{count}</strong></div>)}</div> : <EmptySmall title="ยังไม่มีข้อมูลทักษะ" text="อัปโหลดเรซูเม่หรือโหลดข้อมูลตัวอย่างเพื่อดูภาพรวม" onClick={onLoadDemo} />}</div>
    </section>

    <section className="dashboard-grid lower-grid"><div className="panel recent-panel"><div className="panel-heading"><div><h3>ผู้สมัครล่าสุด</h3><p>รายการที่บันทึกไว้ในระบบ</p></div><button className="icon-text-button" onClick={() => onNavigate('candidates')}>ดูทั้งหมด <ChevronRight size={15} /></button></div>{recent.length ? <div className="recent-list">{recent.map((candidate) => <button className="recent-row" key={candidate.id} onClick={() => onOpenCandidate(candidate.id)}><div className="candidate-avatar">{initials(candidate.name)}</div><div className="recent-info"><strong>{candidate.name}</strong><span>{jobs.find((job) => job.id === candidate.jobId)?.title ?? 'ไม่พบตำแหน่งงาน'}</span></div><div className="recent-meta"><strong className={scoreTone(candidate.score)}>{candidate.score === null ? '—' : `${candidate.score}%`}</strong><span className={`status-badge ${statusClasses[candidate.status]}`}>{statusLabels[candidate.status]}</span></div><ChevronRight className="recent-chevron" size={16} /></button>)}</div> : <EmptySmall title="ยังไม่มีผู้สมัคร" text="เพิ่มเรซูเม่เพื่อเริ่มวิเคราะห์ตามเกณฑ์งาน" onClick={() => onNavigate('upload')} />}</div>
      <div className="panel pipeline-panel"><div className="panel-heading"><div><h3>สถานะผู้สมัคร</h3><p>ความคืบหน้าจากการตรวจสอบของ HR</p></div><div className="panel-icon"><ClipboardCheck size={18} /></div></div><div className="pipeline-list">{(Object.keys(statusLabels) as CandidateStatus[]).map((status) => { const count = statusCounts[status]; const percent = candidates.length ? (count / candidates.length) * 100 : 0; return <div className="pipeline-row" key={status}><div><span className={`status-dot ${statusClasses[status]}`} /><span>{statusLabels[status]}</span><strong>{count}</strong></div><div className="pipeline-track"><span style={{ width: `${percent}%` }} /></div></div>; })}</div><div className="pipeline-footer"><span><FileCheck2 size={14} /> ไฟล์ที่อ่านไม่สำเร็จ</span><strong>{unreadableCount} ไฟล์</strong></div></div></section>

    {candidates.length === 0 && jobs.length === 0 && <div className="empty-state-card"><div className="empty-illustration"><UsersRound size={26} /></div><h3>เริ่มต้นพื้นที่คัดกรองของคุณ</h3><p>โหลดข้อมูลตัวอย่างเพื่อทดลอง หรือสร้างตำแหน่งงานของคุณเองก่อนอัปโหลด PDF</p><div><button className="button button-primary" onClick={onLoadDemo}><Sparkles size={16} /> โหลดข้อมูลตัวอย่าง</button><button className="button button-secondary" onClick={() => onNavigate('jobs')}><Plus size={16} /> สร้างตำแหน่งงาน</button><button className="button button-quiet" onClick={onReset}><Trash2 size={15} /> รีเซ็ตการทดลอง</button></div></div>}
  </>;
}

function StatCard({ icon, title, value, note, tone, onClick }: { icon: ReactNode; title: string; value: number; note: string; tone: string; onClick?: () => void }) {
  const content = <><div className={`stat-icon stat-${tone}`}>{icon}</div><div className="stat-label">{title}</div><div className="stat-value">{value.toLocaleString('th-TH')}</div><div className="stat-note">{note}{onClick && <ChevronRight size={13} />}</div></>;
  return onClick ? <button className="stat-card" onClick={onClick}>{content}</button> : <div className="stat-card">{content}</div>;
}

function EmptySmall({ title, text, onClick }: { title: string; text: string; onClick?: () => void }) {
  return <div className="empty-small"><div className="empty-small-icon"><FileText size={18} /></div><strong>{title}</strong><p>{text}</p>{onClick && <button className="text-button" onClick={onClick}>เริ่มต้นใช้งาน <ArrowRight size={14} /></button>}</div>;
}

function JobsPage({ jobs, candidates, onCreate, onEdit, onDelete, onUpload }: { jobs: Job[]; candidates: Candidate[]; onCreate: () => void; onEdit: (job: Job) => void; onDelete: (job: Job) => void; onUpload: (jobId: string) => void }) {
  return <>
    <div className="content-toolbar"><div className="toolbar-summary"><BriefcaseBusiness size={17} /><span>ทั้งหมด <strong>{jobs.length}</strong> ตำแหน่ง</span></div><button className="button button-primary" onClick={onCreate}><Plus size={16} /> สร้างตำแหน่งงาน</button></div>
    {jobs.length ? <div className="jobs-grid">{jobs.map((job) => { const count = candidates.filter((candidate) => candidate.jobId === job.id).length; const weight = totalWeight(job.criteria); return <article className="job-card" key={job.id}><div className="job-card-top"><div className="job-icon"><BriefcaseBusiness size={20} /></div><div className="job-card-menu"><span className="tiny-version">v{job.criteriaVersion}</span><button className="icon-button" aria-label={`แก้ไข ${job.title}`} onClick={() => onEdit(job)}><Settings2 size={17} /></button></div></div><div className="job-title-group"><h3>{job.title}</h3><span>{job.department || 'ยังไม่ระบุฝ่าย'}</span></div><p className="job-description">{job.description || 'ยังไม่มีรายละเอียดตำแหน่งงาน'}</p><div className="job-stats"><div><span>ผู้สมัคร</span><strong>{count}</strong></div><div><span>จำนวนเกณฑ์</span><strong>{job.criteria.length} เกณฑ์</strong></div><div><span>น้ำหนักรวม</span><strong className={Math.abs(weight - 100) < .01 ? 'text-green' : 'text-red'}>{weight}%</strong></div></div><div className="job-criteria-preview">{job.criteria.slice(0, 4).map((criterion) => <div className="criteria-preview-row" key={criterion.id}><span>{criterion.label}</span><span>{criterion.weight}%</span></div>)}</div><div className="job-card-actions"><button className="button button-primary button-grow" onClick={() => onUpload(job.id)}><FolderUp size={15} /> อัปโหลดเรซูเม่</button><button className="button button-secondary" onClick={() => onEdit(job)}>แก้ไข</button><button className="icon-button danger-icon" aria-label={`ลบ ${job.title}`} onClick={() => onDelete(job)}><Trash2 size={16} /></button></div></article>; })}<button className="add-job-card" onClick={onCreate}><span><Plus size={22} /></span><strong>เพิ่มตำแหน่งงานใหม่</strong><small>กำหนดคุณสมบัติและน้ำหนักเกณฑ์</small></button></div> : <div className="empty-state-card"><div className="empty-illustration"><BriefcaseBusiness size={26} /></div><h3>ยังไม่มีตำแหน่งงาน</h3><p>เริ่มด้วยการสร้างตำแหน่งงานและระบุเกณฑ์ที่ใช้เปรียบเทียบเรซูเม่</p><button className="button button-primary" onClick={onCreate}><Plus size={16} /> สร้างตำแหน่งงานแรก</button></div>}
    <div className="tip-strip"><div><ShieldCheck size={18} /><strong>แนวทางที่แนะนำ</strong></div><p>กำหนดเกณฑ์ที่เกี่ยวข้องกับงานโดยตรง ตรวจให้น้ำหนักรวมเป็น 100% และทบทวนเกณฑ์ทุกครั้งที่ตำแหน่งงานเปลี่ยนไป</p></div>
  </>;
}

function UploadPage({ jobs, uploadJobId, setUploadJobId, uploadTasks, uploading, dragActive, setDragActive, fileInputRef, onFileInput, onProcessFiles, onGoJobs }: {
  jobs: Job[]; uploadJobId: string; setUploadJobId: (id: string) => void; uploadTasks: UploadTask[]; uploading: boolean; dragActive: boolean; setDragActive: (active: boolean) => void;
  fileInputRef: RefObject<HTMLInputElement>; onFileInput: (event: ChangeEvent<HTMLInputElement>) => void; onProcessFiles: (files: FileList | File[]) => Promise<void>; onGoJobs: () => void;
}) {
  const activeJob = jobs.find((job) => job.id === uploadJobId);
  const [localError, setLocalError] = useState('');
  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragActive(false);
    if (event.dataTransfer.files.length) {
      setLocalError('');
      void onProcessFiles(event.dataTransfer.files).catch(() => setLocalError('เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองใหม่'));
    }
  }
  return <div className="upload-layout">
    <section className="panel upload-panel"><div className="upload-step-label"><span>STEP 01</span><span className="step-line" /><span>นำเข้าเอกสาร</span></div><h2>เพิ่มเรซูเม่ผู้สมัคร</h2><p className="panel-intro">อัปโหลดไฟล์ PDF ที่มีข้อความจริง ระบบจะอ่านข้อความก่อนคำนวณคะแนน และไม่สร้างผลหากอ่านไฟล์ไม่สำเร็จ</p>
      {!jobs.length ? <div className="inline-empty"><BriefcaseBusiness size={24} /><strong>ต้องมีตำแหน่งงานก่อน</strong><p>สร้างตำแหน่งงานและเกณฑ์คะแนน เพื่อให้ระบบทราบว่าจะเปรียบเทียบเรซูเม่กับอะไร</p><button className="button button-primary" onClick={onGoJobs}><Plus size={16} /> สร้างตำแหน่งงาน</button></div> : <>
        <label className="field-label" htmlFor="upload-job-select">ตำแหน่งงานที่จะใช้วิเคราะห์</label><div className="select-with-icon"><BriefcaseBusiness size={16} /><select id="upload-job-select" value={uploadJobId} onChange={(event) => setUploadJobId(event.target.value)}>{jobs.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}</select><ChevronDown size={15} /></div>
        {activeJob && <div className="selected-job-summary"><div className="selected-job-top"><div><strong>{activeJob.title}</strong><span>{activeJob.department || 'ไม่ระบุฝ่าย'}</span></div><span className="criteria-version-badge">เกณฑ์ v{activeJob.criteriaVersion}</span></div><div className="selected-job-criteria">{activeJob.criteria.map((criterion) => <span key={criterion.id}>{criterion.label} <b>{criterion.weight}%</b></span>)}</div><div className={`weight-check ${Math.abs(totalWeight(activeJob.criteria) - 100) < 0.01 ? 'weight-valid' : 'weight-invalid'}`}>{Math.abs(totalWeight(activeJob.criteria) - 100) < 0.01 ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />} น้ำหนักรวม {totalWeight(activeJob.criteria)}% {Math.abs(totalWeight(activeJob.criteria) - 100) < 0.01 ? 'พร้อมวิเคราะห์' : 'ต้องแก้ให้ครบ 100% ก่อน'}</div></div>}
        <div className={`drop-zone ${dragActive ? 'drag-active' : ''} ${uploading ? 'is-loading' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={handleDrop}><input ref={fileInputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={onFileInput} /><div className="upload-icon"><FolderUp size={25} /></div><strong>{uploading ? 'กำลังอ่านข้อความจาก PDF…' : 'ลากไฟล์มาวางที่นี่'}</strong><span>หรือกดปุ่มด้านล่างเพื่อเลือกไฟล์จากอุปกรณ์</span><button type="button" className="button button-secondary" onClick={() => fileInputRef.current?.click()} disabled={uploading}><Plus size={16} /> เลือกไฟล์ PDF</button><div className="upload-limits"><span><CheckCircle2 size={13} /> PDF หลายไฟล์</span><span><CheckCircle2 size={13} /> สูงสุด 20 MB/ไฟล์</span><span><ShieldCheck size={13} /> อ่านในเบราว์เซอร์</span></div></div>
        {localError && <div className="inline-error"><AlertCircle size={15} /> {localError}</div>}
<p>
  ระบบจะจัดเก็บข้อมูลตามการตั้งค่าของ backend และฐานข้อมูล
  หากใช้สรุป AI จริง ข้อความเรซูเม่จะถูกส่งไปยัง backend ที่ตั้งค่าไว้
</p>      </>}
    </section>
    <section className="panel upload-queue-panel"><div className="panel-heading"><div><h3>สถานะการอ่านไฟล์</h3><p>ดูผลลัพธ์ของแต่ละไฟล์แบบรายไฟล์</p></div><span className="queue-count">{uploadTasks.length} ไฟล์</span></div>{uploadTasks.length ? <div className="upload-queue-list">{uploadTasks.map((task) => <div className="upload-queue-row" key={task.id}><div className={`file-status-icon ${task.state === 'กำลังอ่าน' ? 'file-progress' : task.state === 'อ่านสำเร็จ' ? 'file-success' : 'file-error'}`}>{task.state === 'กำลังอ่าน' ? <LoaderCircle size={18} className="spin" /> : task.state === 'อ่านสำเร็จ' ? <FileCheck2 size={18} /> : <AlertCircle size={18} />}</div><div className="upload-file-info"><strong title={task.name}>{task.name}</strong><span>{task.message ?? 'กำลังเตรียมอ่านไฟล์'}</span></div><span className={`file-result-badge ${task.state === 'กำลังอ่าน' ? 'file-badge-progress' : task.state === 'อ่านสำเร็จ' ? 'file-badge-success' : 'file-badge-error'}`}>{task.state}</span></div>)}</div> : <div className="queue-empty"><div className="queue-empty-graphic"><FileText size={24} /></div><strong>ยังไม่มีไฟล์ในรายการ</strong><p>เมื่อเลือกไฟล์แล้ว จะแสดงสถานะการอ่านและเหตุผลหากพบข้อผิดพลาดที่นี่</p></div>}<div className="upload-queue-footer"><div><span className="legend-dot dot-success" /> อ่านสำเร็จ <b>{uploadTasks.filter((item) => item.state === 'อ่านสำเร็จ').length}</b></div><div><span className="legend-dot dot-error" /> อ่านไม่สำเร็จ <b>{uploadTasks.filter((item) => item.state === 'อ่านไม่สำเร็จ').length}</b></div></div></section>
    <div className="upload-help panel"><div className="help-icon"><CircleHelp size={19} /></div><div><strong>ไฟล์แบบไหนใช้ได้ดีที่สุด?</strong><p>ใช้ PDF ที่สร้างจาก Word หรือระบบสมัครงาน ซึ่งสามารถเลือกข้อความได้ หากเป็นรูปภาพที่สแกนมา ระบบจะแจ้งว่าต้องใช้ OCR และจะไม่ให้คะแนนแทนข้อมูลที่อ่านไม่ได้</p></div></div>
  </div>;
}

function CandidatesPage({ candidates, allCandidates, jobs, searchText, setSearchText, jobFilter, setJobFilter, statusFilter, setStatusFilter, minScoreFilter, setMinScoreFilter, sortByScore, setSortByScore, selectedForCompare, toggleCompare, setCompareOpen, onOpenCandidate, onExport, onUpload }: {
  candidates: Candidate[]; allCandidates: Candidate[]; jobs: Job[]; searchText: string; setSearchText: (value: string) => void; jobFilter: string; setJobFilter: (value: string) => void;
  statusFilter: string; setStatusFilter: (value: string) => void; minScoreFilter: string; setMinScoreFilter: (value: string) => void; sortByScore: boolean; setSortByScore: (value: boolean) => void;
  selectedForCompare: string[]; toggleCompare: (id: string) => void; setCompareOpen: (value: boolean) => void; onOpenCandidate: (id: string) => void; onExport: (list?: Candidate[]) => void; onUpload: () => void;
}) {
  const [showFilters, setShowFilters] = useState(false);
  return <>
    <div className="candidate-topline"><div><div className="candidate-result-count">แสดง <strong>{candidates.length}</strong> จาก {allCandidates.length} ผู้สมัคร</div><span className="muted-caption">กดชื่อผู้สมัครเพื่อดูหลักฐานคะแนนและแก้ข้อมูลที่ดึงจากเรซูเม่</span></div><div className="candidate-actions"><button className={`button ${showFilters ? 'button-primary' : 'button-secondary'}`} onClick={() => setShowFilters(!showFilters)}><Filter size={16} /> ตัวกรอง <ChevronDown size={14} /></button><button className="button button-secondary" onClick={() => onExport(candidates)}><Download size={16} /> ส่งออก CSV</button><button className="button button-primary" onClick={onUpload}><Plus size={16} /> เพิ่มผู้สมัคร</button></div></div>
    <div className="candidate-filter-bar"><div className="search-field"><Search size={17} /><input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="ค้นหาชื่อ อีเมล หรือชื่อไฟล์…" aria-label="ค้นหาผู้สมัคร" />{searchText && <button aria-label="ล้างการค้นหา" onClick={() => setSearchText('')}><X size={14} /></button>}</div><button className="sort-button" onClick={() => setSortByScore(!sortByScore)}><ArrowDownUp size={16} /> {sortByScore ? 'คะแนนสูงไปต่ำ' : 'ลำดับเดิม'}</button>{showFilters && <div className="expanded-filters"><label>ตำแหน่งงาน<select value={jobFilter} onChange={(event) => setJobFilter(event.target.value)}><option value="all">ทุกตำแหน่ง</option>{jobs.map((job) => <option value={job.id} key={job.id}>{job.title}</option>)}</select></label><label>สถานะ<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">ทุกสถานะ</option>{(Object.keys(statusLabels) as CandidateStatus[]).map((status) => <option value={status} key={status}>{statusLabels[status]}</option>)}</select></label><label>คะแนนขั้นต่ำ<select value={minScoreFilter} onChange={(event) => setMinScoreFilter(event.target.value)}><option value="all">ทุกคะแนน</option><option value="80">80% ขึ้นไป</option><option value="70">70% ขึ้นไป</option><option value="60">60% ขึ้นไป</option></select></label><button className="text-button" onClick={() => { setJobFilter('all'); setStatusFilter('all'); setMinScoreFilter('all'); setSearchText(''); }}>ล้างตัวกรอง</button></div>}</div>
    {selectedForCompare.length > 0 && <div className="compare-selection"><div><ListChecks size={18} /><strong>เลือกแล้ว {selectedForCompare.length} คน</strong><span>เลือกได้สูงสุด 4 คนเพื่อเปรียบเทียบ</span></div><button className="button button-primary button-small" onClick={() => setCompareOpen(true)} disabled={selectedForCompare.length < 2}>เปรียบเทียบผู้สมัคร <ArrowRight size={15} /></button><button className="icon-button" onClick={() => selectedForCompare.forEach((id) => toggleCompare(id))} aria-label="ล้างผู้สมัครที่เลือก"><X size={17} /></button></div>}
    <div className="panel candidate-table-panel"><div className="table-scroll"><table className="data-table"><thead><tr><th className="check-cell"><span className="sr-only">เลือกเปรียบเทียบ</span></th><th>ผู้สมัคร</th><th>ตำแหน่งงาน</th><th><button className="th-sort" onClick={() => setSortByScore(!sortByScore)}>คะแนน <ArrowDownUp size={13} /></button></th><th>ทักษะที่ตรง</th><th>สถานะ</th><th>วิเคราะห์ล่าสุด</th><th></th></tr></thead><tbody>{candidates.map((candidate) => { const job = jobs.find((item) => item.id === candidate.jobId); const matched = [...new Set(candidate.results.flatMap((result) => result.matchedKeywords))]; return <tr key={candidate.id}><td className="check-cell"><input type="checkbox" checked={selectedForCompare.includes(candidate.id)} onChange={() => toggleCompare(candidate.id)} aria-label={`เลือก ${candidate.name} เพื่อเปรียบเทียบ`} /></td><td><button className="candidate-cell-button" onClick={() => onOpenCandidate(candidate.id)}><span className="candidate-avatar">{initials(candidate.name)}</span><span className="candidate-cell-text"><strong>{candidate.name}</strong><small>{candidate.email || candidate.fileName}</small>{candidate.isDemo && <span className="demo-mini-tag">ข้อมูลตัวอย่าง</span>}</span></button></td><td><span className="job-cell-title">{job?.title ?? 'ตำแหน่งถูกลบ'}</span><small className="job-cell-dept">{job?.department ?? '—'}</small></td><td><span className={`score-pill ${scoreTone(candidate.score)}`}>{candidate.score === null ? '—' : `${candidate.score}%`}</span>{candidate.score !== null && <div className="score-mini-track"><span className={scoreTone(candidate.score)} style={{ width: `${candidate.score}%` }} /></div>}</td><td><div className="match-tags">{matched.length ? <>{matched.slice(0, 2).map((skill) => <span key={skill}>{skill}</span>)}{matched.length > 2 && <small>+{matched.length - 2}</small>}</> : <span className="no-match">{candidate.parseStatus === 'error' ? 'อ่านไม่สำเร็จ' : 'ยังไม่พบ'}</span>}</div></td><td><span className={`status-badge ${statusClasses[candidate.status]}`}>{statusLabels[candidate.status]}</span></td><td><span className="date-cell">{formatDate(candidate.analyzedAt)}</span><small className="version-cell">เกณฑ์ {candidate.criteriaVersion}</small></td><td><button className="icon-button" aria-label={`ดูรายละเอียด ${candidate.name}`} onClick={() => onOpenCandidate(candidate.id)}><ChevronRight size={17} /></button></td></tr>; })}</tbody></table></div>
      {!candidates.length && <div className="table-empty"><div className="empty-illustration"><Search size={25} /></div><h3>{allCandidates.length ? 'ไม่พบผู้สมัครที่ตรงกับตัวกรอง' : 'ยังไม่มีผู้สมัครในระบบ'}</h3><p>{allCandidates.length ? 'ลองเปลี่ยนคำค้นหา หรือกดล้างตัวกรองแล้วค้นหาใหม่' : 'เพิ่มเรซูเม่ PDF เพื่อเริ่มวิเคราะห์ตามเกณฑ์ตำแหน่งงาน'}</p>{allCandidates.length ? <button className="button button-secondary" onClick={() => { setJobFilter('all'); setStatusFilter('all'); setMinScoreFilter('all'); setSearchText(''); }}>ล้างตัวกรอง</button> : <button className="button button-primary" onClick={onUpload}><FolderUp size={16} /> อัปโหลดเรซูเม่</button>}</div>}
      <div className="table-footer"><span>ข้อมูล {candidates.length} รายการ</span><span>คะแนนและสถานะเป็นข้อมูลช่วยตรวจสอบ ไม่ใช่การตัดสินใจอัตโนมัติ</span></div>
    </div>
  </>;
}

function ReportsPage({ jobs, candidates, onExport }: { jobs: Job[]; candidates: Candidate[]; onExport: (list?: Candidate[]) => void }) {
  const [reportFilter, setReportFilter] = useState('all');
  const reportCandidates = candidates.filter((candidate) => reportFilter === 'all' || candidate.jobId === reportFilter);
  const scored = reportCandidates.filter((candidate) => candidate.score !== null);
  const avg = scored.length ? Math.round(scored.reduce((sum, candidate) => sum + (candidate.score ?? 0), 0) / scored.length) : null;
  const distribution = [
    { label: '80–100%', count: scored.filter((candidate) => (candidate.score ?? 0) >= 80).length, tone: 'bar-high' },
    { label: '60–79%', count: scored.filter((candidate) => (candidate.score ?? 0) >= 60 && (candidate.score ?? 0) < 80).length, tone: 'bar-mid' },
    { label: 'ต่ำกว่า 60%', count: scored.filter((candidate) => (candidate.score ?? 0) < 60).length, tone: 'bar-low' },
  ];
  const skills = new Map<string, number>();
  reportCandidates.forEach((candidate) => candidate.results.forEach((result) => result.matchedKeywords.forEach((keyword) => skills.set(keyword, (skills.get(keyword) ?? 0) + 1))));
  const topSkills = [...skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const total = Math.max(1, ...distribution.map((item) => item.count));
  return <>
    <div className="reports-toolbar"><div><label className="field-label" htmlFor="report-job-filter">ดูรายงานตำแหน่งงาน</label><div className="select-with-icon report-select"><BriefcaseBusiness size={16} /><select id="report-job-filter" value={reportFilter} onChange={(event) => setReportFilter(event.target.value)}><option value="all">ทุกตำแหน่งงาน</option>{jobs.map((job) => <option value={job.id} key={job.id}>{job.title}</option>)}</select><ChevronDown size={15} /></div></div><button className="button button-primary" onClick={() => onExport(reportCandidates)}><Download size={16} /> ดาวน์โหลดรายงาน CSV</button></div>
    <div className="stats-grid report-stats"><StatCard icon={<UsersRound size={19} />} title="ผู้สมัครในรายงาน" value={reportCandidates.length} note="ตามตัวกรองปัจจุบัน" tone="green" onClick={() => {}} /><StatCard icon={<Gauge size={19} />} title="คะแนนเฉลี่ย" value={avg ?? 0} note={avg === null ? 'ยังไม่มีคะแนน' : 'จากผู้สมัครที่วิเคราะห์ได้'} tone="blue" onClick={() => {}} /><StatCard icon={<AlertCircle size={19} />} title="อ่าน PDF ไม่สำเร็จ" value={reportCandidates.filter((candidate) => candidate.parseStatus === 'error').length} note="ต้องใช้ไฟล์ที่อ่านข้อความได้" tone="rose" onClick={() => {}} /><StatCard icon={<ClipboardCheck size={19} />} title="ต้องตรวจสอบ" value={reportCandidates.filter((candidate) => candidate.status === 'pending' || candidate.status === 'consider').length} note="รอการตรวจโดย HR" tone="amber" onClick={() => {}} /></div>
    <div className="dashboard-grid reports-grid"><section className="panel"><div className="panel-heading"><div><h3>การกระจายคะแนน</h3><p>จำนวนผู้สมัครแยกตามช่วงคะแนน</p></div><div className="panel-icon"><BarChart3 size={18} /></div></div><div className="report-distribution">{distribution.map((item) => <div key={item.label} className="report-dist-row"><div><span>{item.label}</span><strong>{item.count}</strong></div><div className="distribution-track"><div className={`distribution-fill ${item.tone}`} style={{ width: `${(item.count / total) * 100}%` }} /></div></div>)}</div></section>
      <section className="panel"><div className="panel-heading"><div><h3>ทักษะที่ตรงกับเกณฑ์</h3><p>จำนวนครั้งที่พบในผลวิเคราะห์</p></div><div className="panel-icon"><Target size={18} /></div></div>{topSkills.length ? <div className="report-skill-grid">{topSkills.map(([skill, count]) => <div className="report-skill-chip" key={skill}><span>{skill}</span><strong>{count}</strong></div>)}</div> : <EmptySmall title="ยังไม่มีข้อมูล" text="อัปโหลดเรซูเม่เพื่อสร้างรายงานจากข้อมูลจริง" />}</section></div>
    <section className="panel report-jobs-panel"><div className="panel-heading"><div><h3>สรุปตามตำแหน่งงาน</h3><p>ใช้ข้อมูลจริงที่บันทึกอยู่ในระบบ ไม่มีการเติมตัวเลขจำลอง</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>ตำแหน่งงาน</th><th>ผู้สมัคร</th><th>วิเคราะห์ได้</th><th>คะแนนเฉลี่ย</th><th>คะแนนตั้งแต่ 70%</th><th>อ่านไม่สำเร็จ</th></tr></thead><tbody>{jobs.filter((job) => reportFilter === 'all' || job.id === reportFilter).map((job) => { const list = candidates.filter((candidate) => candidate.jobId === job.id); const withScore = list.filter((candidate) => candidate.score !== null); const average = withScore.length ? Math.round(withScore.reduce((sum, candidate) => sum + (candidate.score ?? 0), 0) / withScore.length) : null; return <tr key={job.id}><td><strong className="job-cell-title">{job.title}</strong><small className="job-cell-dept">{job.department}</small></td><td>{list.length}</td><td>{withScore.length}</td><td><span className={`score-pill ${scoreTone(average)}`}>{average === null ? '—' : `${average}%`}</span></td><td>{list.filter((candidate) => candidate.score !== null && candidate.score >= 70).length}</td><td>{list.filter((candidate) => candidate.parseStatus === 'error').length}</td></tr>; })}</tbody></table></div>{jobs.length === 0 && <div className="table-empty compact-empty"><h3>ยังไม่มีตำแหน่งงาน</h3><p>รายงานจะแสดงหลังสร้างตำแหน่งงานและเพิ่มผู้สมัคร</p></div>}</section>
    <div className="report-disclaimer"><ShieldCheck size={17} /><p><strong>การใช้รายงานอย่างรับผิดชอบ</strong><br />คะแนนแสดงการตรงกับคำสำคัญที่ HR กำหนดเท่านั้น ไม่ได้พิสูจน์คุณภาพการทำงานจริง และไม่ควรใช้ปฏิเสธผู้สมัครโดยอัตโนมัติ</p></div>
  </>;
}

function JobModal({ draftJob, editing, onClose, onSave, onChange, onUpdateCriterion, onAddCriterion, onRemoveCriterion }: {
  draftJob: Job; editing: boolean; onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void; onChange: (patch: Partial<Job>) => void;
  onUpdateCriterion: (index: number, patch: Partial<Criterion>) => void; onAddCriterion: () => void; onRemoveCriterion: (index: number) => void;
}) {
  const weight = totalWeight(draftJob.criteria);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card job-modal" role="dialog" aria-modal="true" aria-labelledby="job-modal-title"><div className="modal-header"><div><span className="modal-eyebrow">JOB CONFIGURATION</span><h2 id="job-modal-title">{editing ? 'แก้ไขตำแหน่งงาน' : 'สร้างตำแหน่งงานใหม่'}</h2><p>กำหนดรายละเอียดงานและเกณฑ์ที่ใช้คำนวณคะแนน</p></div><button className="icon-button" aria-label="ปิดหน้าต่าง" onClick={onClose}><X size={19} /></button></div><form onSubmit={onSave}><div className="modal-body"><div className="form-grid"><label className="form-field"><span>ชื่อตำแหน่งงาน <b>*</b></span><input required value={draftJob.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="เช่น HR Recruitment Officer" /></label><label className="form-field"><span>ฝ่าย / แผนก</span><input value={draftJob.department} onChange={(event) => onChange({ department: event.target.value })} placeholder="เช่น ทรัพยากรบุคคล" /></label><label className="form-field full-field"><span>รายละเอียดงาน</span><textarea value={draftJob.description} onChange={(event) => onChange({ description: event.target.value })} rows={2} placeholder="อธิบายความรับผิดชอบหลักของตำแหน่งนี้" /></label><label className="form-field full-field"><span>คุณสมบัติขั้นต่ำ (ประกอบการตรวจสอบ; เกณฑ์ด้านล่างใช้คำนวณคะแนน)</span><textarea value={draftJob.minQualification} onChange={(event) => onChange({ minQualification: event.target.value })} rows={2} placeholder="คุณสมบัติที่ควรตรวจสอบเพิ่มเติม" /></label></div><div className="criteria-editor-heading"><div><h3>เกณฑ์การประเมิน</h3><p>คะแนนจะคำนวณจากสัดส่วนคำสำคัญที่พบในแต่ละเกณฑ์</p></div><div className={`weight-total ${Math.abs(weight - 100) < .001 ? 'weight-total-ok' : 'weight-total-error'}`}><strong>{weight}%</strong><span>จาก 100%</span></div></div><div className="criteria-editor-list">{draftJob.criteria.map((criterion, index) => <div className="criterion-editor" key={criterion.id}><div className="criterion-editor-number">{String(index + 1).padStart(2, '0')}</div><div className="criterion-editor-fields"><label><span>ชื่อเกณฑ์</span><input value={criterion.label} required onChange={(event) => onUpdateCriterion(index, { label: event.target.value })} placeholder="เช่น ทักษะด้านเว็บ" /></label><label><span>หมวดหมู่</span><select value={criterion.category} onChange={(event) => onUpdateCriterion(index, { category: event.target.value as CriterionCategory })}>{categories.map((category) => <option key={category} value={category}>{category}</option>)}</select></label><label className="keywords-field"><span>คำสำคัญ (คั่นด้วยจุลภาค ,)</span><input required value={criterion.keywords.join(', ')} onChange={(event) => onUpdateCriterion(index, { keywords: event.target.value.split(',').map((item) => item.trim()) })} placeholder="เช่น React, TypeScript, REST API" /></label></div><label className="weight-field"><span>น้ำหนัก</span><div><input type="number" min={0} max={100} required value={criterion.weight} onChange={(event) => onUpdateCriterion(index, { weight: Number(event.target.value) })} /><b>%</b></div></label><button type="button" className="icon-button danger-icon remove-criterion" disabled={draftJob.criteria.length <= 1} onClick={() => onRemoveCriterion(index)} aria-label="ลบเกณฑ์"><Trash2 size={16} /></button></div>)}</div><button type="button" className="add-criterion-button" onClick={onAddCriterion}><Plus size={15} /> เพิ่มเกณฑ์อีกข้อ</button><div className={`weight-validation ${Math.abs(weight - 100) < .001 ? 'valid' : 'invalid'}`}>{Math.abs(weight - 100) < .001 ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}<span>น้ำหนักรวม <strong>{weight}%</strong> {Math.abs(weight - 100) < .001 ? 'ถูกต้อง พร้อมใช้วิเคราะห์' : `ต้องปรับอีก ${Math.round((100 - weight) * 100) / 100}% ให้ครบ 100%`}</span></div><div className="criteria-method-note"><CircleHelp size={15} /><p>สูตรคะแนน: ผลรวมของ (เปอร์เซ็นต์คำสำคัญที่พบในเกณฑ์ × น้ำหนักเกณฑ์) ÷ น้ำหนักเกณฑ์ที่ประเมินได้ เกณฑ์ที่ไม่มีคำสำคัญจะไม่นำมาคิดคะแนน</p></div></div><div className="modal-footer"><button type="button" className="button button-secondary" onClick={onClose}>ยกเลิก</button><button type="submit" className="button button-primary" disabled={Math.abs(weight - 100) > .001}><Check size={16} /> {editing ? 'บันทึกการแก้ไข' : 'สร้างตำแหน่งงาน'}</button></div></form></section></div>;
}

function CandidateModal({ candidate, job, onClose, onChangeField, onChangeStatus, onRequestAi, aiLoading }: {
  candidate: Candidate; job: Job; onClose: () => void; onChangeField: (id: string, field: 'name' | 'email' | 'phone' | 'education' | 'experience' | 'skills', value: string) => void;
  onChangeStatus: (id: string, status: CandidateStatus) => void; onRequestAi: () => void; aiLoading: boolean;
}) {
  const score = candidate.score;
  return <div className="modal-backdrop detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card candidate-modal" role="dialog" aria-modal="true" aria-labelledby="candidate-modal-title"><div className="modal-header candidate-modal-header"><div className="candidate-detail-ident"><div className="candidate-avatar large-avatar">{initials(candidate.name)}</div><div><span className="modal-eyebrow">CANDIDATE PROFILE {candidate.isDemo ? '• DEMO' : ''}</span><h2 id="candidate-modal-title">รายละเอียดผู้สมัคร</h2><p>{job.title} <span>•</span> อัปเดต {formatDate(candidate.analyzedAt)}</p></div></div><button className="icon-button" aria-label="ปิดหน้าต่าง" onClick={onClose}><X size={19} /></button></div><div className="candidate-detail-body"><aside className="candidate-detail-side"><div className="detail-score-card"><span>คะแนนความตรงกับเกณฑ์</span><div className={`detail-score-number ${scoreTone(score)}`}>{score === null ? '—' : score}<small>{score === null ? '' : '/100'}</small></div>{score !== null && <div className="detail-score-track"><span className={scoreTone(score)} style={{ width: `${score}%` }} /></div>}<p>{score === null ? 'ยังไม่มีคะแนนที่เชื่อถือได้' : score >= 70 ? 'คะแนนตั้งแต่ 70% เป็นเพียงสัญญาณให้ตรวจสอบต่อ' : 'ควรตรวจทานหลักฐานและเกณฑ์ก่อนสรุปผล'}</p><span className={`status-badge ${statusClasses[candidate.status]}`}>{statusLabels[candidate.status]}</span></div><div className="detail-file-card"><FileText size={19} /><div><strong>{candidate.fileName}</strong><span>{candidate.parseStatus === 'success' ? `อ่านข้อความ ${candidate.rawText.length.toLocaleString('th-TH')} ตัวอักษร` : 'อ่านไฟล์ไม่สำเร็จ'}</span></div></div>{candidate.parseStatus === 'error' && <div className="parse-error-box"><AlertCircle size={16} /><div><strong>ไม่สามารถประเมินได้</strong><p>{candidate.parseError}</p></div></div>}<div className="detail-stats-mini"><div><span>เวอร์ชันเกณฑ์</span><strong>{candidate.criteriaVersion}</strong></div><div><span>วันที่วิเคราะห์</span><strong>{formatDate(candidate.analyzedAt)}</strong></div></div><button className="button button-primary button-full" onClick={onRequestAi} disabled={aiLoading || candidate.parseStatus !== 'success'}>{aiLoading ? <><LoaderCircle size={16} className="spin" /> กำลังขอสรุป…</> : <><Sparkles size={16} /> สร้างสรุปด้วย AI</>}</button><p className="ai-small-note">ต้องเปิด backend และตั้งค่า API Key ก่อนใช้ หากไม่ได้ตั้งค่า ปุ่มนี้จะแจ้งวิธีแก้</p></aside>
      <div className="candidate-detail-main"><section className="detail-section"><div className="detail-section-heading"><div><h3>ข้อมูลที่ดึงจากเรซูเม่</h3><p>ตรวจสอบและแก้ไขข้อมูลได้ก่อนใช้งาน</p></div><span className="editable-tag"><Settings2 size={12} /> แก้ไขได้</span></div><div className="detail-edit-grid"><label className="form-field"><span>ชื่อผู้สมัคร</span><input value={candidate.name} onChange={(event) => onChangeField(candidate.id, 'name', event.target.value)} /></label><label className="form-field"><span>อีเมล</span><input type="email" value={candidate.email} onChange={(event) => onChangeField(candidate.id, 'email', event.target.value)} placeholder="ไม่พบข้อมูล" /></label><label className="form-field"><span>เบอร์โทรศัพท์</span><input value={candidate.phone} onChange={(event) => onChangeField(candidate.id, 'phone', event.target.value)} placeholder="ไม่พบข้อมูล" /></label><label className="form-field"><span>การศึกษา (ข้อความที่พบ)</span><input value={candidate.education} onChange={(event) => onChangeField(candidate.id, 'education', event.target.value)} placeholder="ไม่พบข้อมูลชัดเจน" /></label><label className="form-field full-field"><span>ประสบการณ์ (ข้อความที่พบ)</span><input value={candidate.experience} onChange={(event) => onChangeField(candidate.id, 'experience', event.target.value)} placeholder="ไม่พบข้อมูลชัดเจน" /></label><label className="form-field full-field"><span>ทักษะที่ดึงได้ (คั่นด้วยจุลภาค)</span><input value={candidate.skills.join(', ')} onChange={(event) => onChangeField(candidate.id, 'skills', event.target.value)} placeholder="ยังไม่พบคำสำคัญจากเกณฑ์" /></label></div></section>
      <section className="detail-section criteria-result-section"><div className="detail-section-heading"><div><h3>ผลวิเคราะห์รายเกณฑ์</h3><p>หลักฐานอ้างอิงจากข้อความในไฟล์ที่อ่านได้</p></div><span className="criteria-version-badge">เกณฑ์ v{job.criteriaVersion}</span></div>{candidate.results.length ? <div className="criterion-results">{candidate.results.map((result) => <div className="criterion-result" key={result.criterionId}><div className="criterion-result-top"><div><span className="criterion-category-tag">{result.category}</span><strong>{result.label}</strong></div><div className="criterion-result-score"><strong>{result.status === 'unknown' ? 'N/A' : `${result.percent}%`}</strong><span>น้ำหนัก {result.weight}%</span></div></div>{result.status !== 'unknown' && <div className="criterion-progress-track"><span className={result.percent >= 80 ? 'bar-high' : result.percent >= 50 ? 'bar-mid' : 'bar-low'} style={{ width: `${result.percent}%` }} /></div>}<div className="keyword-result-wrap">{result.matchedKeywords.map((keyword) => <span className="keyword-hit" key={`hit-${keyword}`}><Check size={11} /> {keyword}</span>)}{result.missingKeywords.map((keyword) => <span className="keyword-miss" key={`miss-${keyword}`}>{keyword}</span>)}{result.status === 'unknown' && <span className="no-match">ไม่สามารถประเมินได้: ยังไม่มีคำสำคัญในเกณฑ์นี้</span>}</div>{result.evidence.length > 0 ? <div className="evidence-block"><span><FileCheck2 size={13} /> หลักฐานจากเรซูเม่</span>{result.evidence.map((evidence, index) => <blockquote key={index}>“{evidence}”</blockquote>)}</div> : result.status !== 'unknown' && <div className="evidence-missing"><AlertCircle size={13} /> ไม่พบข้อความอ้างอิงที่ตรงกับคำสำคัญในบรรทัดเดียวกัน</div>}</div>)}</div> : <div className="no-score-explanation"><AlertCircle size={18} /><div><strong>ยังไม่มีผลคะแนน</strong><p>{candidate.parseStatus === 'error' ? 'แก้ปัญหาไฟล์และอัปโหลด PDF ที่มีข้อความก่อน' : 'ตรวจสอบว่าตำแหน่งงานมีเกณฑ์ที่ถูกต้อง แล้ววิเคราะห์อีกครั้ง'}</p></div></div>}</section>
      {candidate.aiInsight && <section className="detail-section ai-insight-section"><div className="detail-section-heading"><div><h3><Sparkles size={17} /> สรุปจาก AI</h3><p>เป็นข้อความช่วยตรวจสอบ ไม่ใช่คะแนนอัตโนมัติ</p></div></div><div className="ai-insight-text">{candidate.aiInsight.split('\n').map((line, index) => line.trim() ? <p key={index}>{line}</p> : null)}</div></section>}
      <section className="detail-section rawtext-section"><details><summary><span><FileText size={15} /> ดูข้อความดิบที่อ่านได้จาก PDF</span><ChevronDown size={15} /></summary><pre>{candidate.rawText || candidate.parseError || 'ไม่มีข้อความให้อ่าน'}</pre></details></section>
      <section className="hr-decision-section"><div><h3>การตัดสินใจของ HR</h3><p>สถานะจะถูกบันทึกในเบราว์เซอร์นี้ทันที ผู้สมัครไม่ได้ถูกปฏิเสธโดยอัตโนมัติจากคะแนน</p></div><div className="decision-buttons">{(['reviewed', 'interview', 'consider', 'rejected'] as CandidateStatus[]).map((status) => <button key={status} className={`decision-button ${candidate.status === status ? 'decision-active' : ''} ${status === 'rejected' ? 'decision-danger' : ''}`} onClick={() => onChangeStatus(candidate.id, status)}>{status === 'reviewed' ? <CheckCircle2 size={15} /> : status === 'interview' ? <UsersRound size={15} /> : status === 'consider' ? <Clock3 size={15} /> : <XCircle size={15} />}{statusLabels[status]}</button>)}<button className={`decision-button ${candidate.status === 'pending' ? 'decision-active' : ''}`} onClick={() => onChangeStatus(candidate.id, 'pending')}><Clock3 size={15} /> รอตรวจสอบ</button></div></section></div></div><div className="candidate-modal-footer"><span><ShieldCheck size={14} /> AI อาจผิดพลาด ให้ตรวจสอบข้อมูลและหลักฐานก่อนตัดสินใจ</span><button className="button button-secondary" onClick={onClose}>ปิดรายละเอียด</button></div></section></div>;
}

function CompareModal({ candidates, jobs, onClose, onOpenCandidate }: { candidates: Candidate[]; jobs: Job[]; onClose: () => void; onOpenCandidate: (id: string) => void }) {
  const selectedJobs = [...new Set(candidates.map((candidate) => candidate.jobId))];
  const sameJob = selectedJobs.length <= 1;
  const comparisonJob = sameJob ? jobs.find((job) => job.id === selectedJobs[0]) : null;
  const criterionIds = comparisonJob?.criteria.map((criterion) => criterion.id) ?? [...new Set(candidates.flatMap((candidate) => candidate.results.map((result) => result.criterionId)))];
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card compare-modal" role="dialog" aria-modal="true" aria-labelledby="compare-title"><div className="modal-header"><div><span className="modal-eyebrow">SIDE-BY-SIDE REVIEW</span><h2 id="compare-title">เปรียบเทียบผู้สมัคร</h2><p>{sameJob ? 'ใช้เกณฑ์เดียวกันสำหรับตำแหน่งนี้' : 'ผู้สมัครมาจากหลายตำแหน่ง คะแนนอาจใช้เกณฑ์คนละชุด'}</p></div><button className="icon-button" aria-label="ปิดหน้าต่าง" onClick={onClose}><X size={19} /></button></div><div className="compare-table-wrap"><table className="compare-table"><thead><tr><th>เกณฑ์</th>{candidates.map((candidate) => <th key={candidate.id}><button onClick={() => onOpenCandidate(candidate.id)} className="compare-person"><span className="candidate-avatar">{initials(candidate.name)}</span><strong>{candidate.name}</strong><span>{jobs.find((job) => job.id === candidate.jobId)?.title}</span></button><div className={`compare-total ${scoreTone(candidate.score)}`}>{candidate.score === null ? '—' : `${candidate.score}%`}</div></th>)}</tr></thead><tbody><tr><td><strong>สถานะ HR</strong></td>{candidates.map((candidate) => <td key={candidate.id}><span className={`status-badge ${statusClasses[candidate.status]}`}>{statusLabels[candidate.status]}</span></td>)}</tr>{criterionIds.map((criterionId) => { const criterion = comparisonJob?.criteria.find((item) => item.id === criterionId); const label = criterion?.label ?? candidates.flatMap((candidate) => candidate.results).find((result) => result.criterionId === criterionId)?.label ?? criterionId; return <tr key={criterionId}><td><strong>{label}</strong><small>{criterion?.weight ? `น้ำหนัก ${criterion.weight}%` : ''}</small></td>{candidates.map((candidate) => { const result = candidate.results.find((item) => item.criterionId === criterionId); return <td key={candidate.id}><strong className={scoreTone(result ? result.percent : null)}>{result ? `${result.percent}%` : 'N/A'}</strong><div className="compare-keywords">{result?.matchedKeywords.slice(0, 3).map((keyword) => <span key={keyword}>{keyword}</span>)}{result && !result.matchedKeywords.length && <small>ยังไม่พบคำสำคัญ</small>}</div></td>; })}</tr>; })}{!sameJob && <tr><td><strong>หมายเหตุ</strong></td>{candidates.map((candidate) => <td key={candidate.id}><small>{candidate.criteriaVersion} · {candidate.parseStatus === 'success' ? 'อ่านสำเร็จ' : 'อ่านไม่สำเร็จ'}</small></td>)}</tr>}</tbody></table></div><div className="compare-modal-footer"><div><ShieldCheck size={15} /><span>เปรียบเทียบเพื่อช่วยตรวจสอบเท่านั้น</span></div><button className="button button-secondary" onClick={onClose}>ปิด</button></div></section></div>;
}
