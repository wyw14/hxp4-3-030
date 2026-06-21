import fs from 'fs';
import path from 'path';
import http from 'http';
import type { LevelData, ConstellationEdge, AnchorPoint, LevelsData } from './types';

interface VerifyApiResult {
  success: boolean;
  valid: boolean;
  isHarmonic: boolean;
  isDefinedEdge: boolean;
  frequencies?: Record<string, number>;
  ratio?: [number, number] | null;
  error?: string;
}

interface EdgeTestResult {
  edge: ConstellationEdge;
  fromPoint: AnchorPoint;
  toPoint: AnchorPoint;
  expectedRatio: [number, number];
  actualRatio: [number, number] | null;
  frequencyFrom: number;
  frequencyTo: number;
  apiResult: VerifyApiResult;
  isAnomaly: boolean;
  anomalyReasons: string[];
}

interface LevelTestReport {
  levelId: number;
  levelName: string;
  creatureName: string;
  totalEdges: number;
  passedEdges: number;
  anomalyEdges: number;
  edgeResults: EdgeTestResult[];
}

interface DebugReport {
  generatedAt: string;
  serverUrl: string;
  serverReachable: boolean;
  totalLevels: number;
  totalEdges: number;
  totalPassed: number;
  totalAnomalies: number;
  levelReports: LevelTestReport[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LEVELS_FILE = path.join(DATA_DIR, 'levels.json');
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3003;
const SERVER_URL = `http://localhost:${PORT}`;

function loadLevels(): LevelsData {
  try {
    const raw = fs.readFileSync(LEVELS_FILE, 'utf-8');
    return JSON.parse(raw) as LevelsData;
  } catch (err) {
    console.error('加载关卡数据失败:', err);
    return { levels: [] };
  }
}

function checkServerHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${SERVER_URL}/api/health`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.success && json.status === 'running');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function verifyEdgeApi(levelId: number, from: string, to: string): Promise<VerifyApiResult> {
  return new Promise((resolve) => {
    const url = `${SERVER_URL}/api/levels/${levelId}/verify?edge=${from}-${to}`;
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as VerifyApiResult);
        } catch {
          resolve({
            success: false,
            valid: false,
            isHarmonic: false,
            isDefinedEdge: false,
            error: '响应解析失败'
          });
        }
      });
    });
    req.on('error', (err) => {
      resolve({
        success: false,
        valid: false,
        isHarmonic: false,
        isDefinedEdge: false,
        error: `请求失败: ${err.message}`
      });
    });
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({
        success: false,
        valid: false,
        isHarmonic: false,
        isDefinedEdge: false,
        error: '请求超时'
      });
    });
  });
}

function calculateActualRatio(f1: number, f2: number): [number, number] | null {
  const maxF = Math.max(f1, f2);
  const minF = Math.min(f1, f2);
  if (minF < 0.0001) return null;

  const ratio = maxF / minF;
  const maxDenom = 10;

  for (let denom = 1; denom <= maxDenom; denom++) {
    const numer = ratio * denom;
    const rounded = Math.round(numer);
    if (Math.abs(numer - rounded) < 0.02 && rounded <= maxDenom && rounded > 0) {
      return f1 >= f2 ? [rounded, denom] : [denom, rounded];
    }
  }

  return null;
}

function simplifyRatio(ratio: [number, number]): [number, number] {
  const f1 = ratio[0];
  const f2 = ratio[1];
  const maxF = Math.max(f1, f2);
  const minF = Math.min(f1, f2);
  if (minF < 0.0001) return [Math.round(f1), Math.round(f2)];

  const rawRatio = maxF / minF;
  const maxDenom = 10;

  for (let denom = 1; denom <= maxDenom; denom++) {
    const numer = rawRatio * denom;
    const rounded = Math.round(numer);
    if (Math.abs(numer - rounded) < 0.02 && rounded <= maxDenom && rounded > 0) {
      const simple: [number, number] = f1 >= f2 ? [rounded, denom] : [denom, rounded];
      const g = gcdInt(simple[0], simple[1]);
      return [simple[0] / g, simple[1] / g];
    }
  }

  return [Math.round(f1), Math.round(f2)];
}

function gcdInt(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b > 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

function ratiosMatch(r1: [number, number], r2: [number, number]): boolean {
  const s1 = simplifyRatio(r1);
  const s2 = simplifyRatio(r2);
  return (s1[0] === s2[0] && s1[1] === s2[1]) ||
         (s1[0] === s2[1] && s1[1] === s2[0]);
}

function apiRatioMatchesActual(apiRatio: [number, number] | null | undefined, f1: number, f2: number): boolean {
  if (!apiRatio) return false;
  const actualMin = Math.min(f1, f2);
  const actualMax = Math.max(f1, f2);
  const apiMin = Math.min(apiRatio[0], apiRatio[1]);
  const apiMax = Math.max(apiRatio[0], apiRatio[1]);
  if (Math.abs(actualMin - apiMin) > 0.01 || Math.abs(actualMax - apiMax) > 0.01) {
    return false;
  }
  return true;
}

async function testLevel(level: LevelData): Promise<LevelTestReport> {
  const edgeResults: EdgeTestResult[] = [];
  let passed = 0;
  let anomalies = 0;

  for (const edge of level.edges) {
    const fromPoint = level.anchorPoints.find(p => p.id === edge.from);
    const toPoint = level.anchorPoints.find(p => p.id === edge.to);

    if (!fromPoint || !toPoint) {
      edgeResults.push({
        edge,
        fromPoint: fromPoint || { id: edge.from, x: 0, y: 0, frequency: 0 },
        toPoint: toPoint || { id: edge.to, x: 0, y: 0, frequency: 0 },
        expectedRatio: edge.frequencyRatio,
        actualRatio: null,
        frequencyFrom: fromPoint?.frequency ?? 0,
        frequencyTo: toPoint?.frequency ?? 0,
        apiResult: {
          success: false,
          valid: false,
          isHarmonic: false,
          isDefinedEdge: false,
          error: '锚点不存在'
        },
        isAnomaly: true,
        anomalyReasons: ['锚点不存在']
      });
      anomalies++;
      continue;
    }

    const apiResult = await verifyEdgeApi(level.id, edge.from, edge.to);
    const actualRatio = calculateActualRatio(fromPoint.frequency, toPoint.frequency);
    const anomalyReasons: string[] = [];

    if (!apiResult.success) {
      anomalyReasons.push(`API调用失败: ${apiResult.error || '未知错误'}`);
    }
    if (!apiResult.valid) {
      anomalyReasons.push('API判定该星脉无效');
    }
    if (!apiResult.isDefinedEdge) {
      anomalyReasons.push('API未识别该星脉为预设边');
    }
    if (!apiResult.isHarmonic) {
      anomalyReasons.push('API判定频率不成简单整数比');
    }

    const expectedSimplified = simplifyRatio(edge.frequencyRatio);

    if (actualRatio) {
      const actualSimplified = simplifyRatio(actualRatio);
      if (!ratiosMatch(edge.frequencyRatio, actualRatio)) {
        anomalyReasons.push(
          `频率比例不匹配: 预设 ${expectedSimplified[0]}:${expectedSimplified[1]}, 实际 ${actualSimplified[0]}:${actualSimplified[1]}`
        );
      }
    } else {
      anomalyReasons.push('无法计算有效的频率比例');
    }

    if (apiResult.ratio) {
      if (!apiRatioMatchesActual(apiResult.ratio, fromPoint.frequency, toPoint.frequency)) {
        const apiMin = Math.min(apiResult.ratio[0], apiResult.ratio[1]);
        const apiMax = Math.max(apiResult.ratio[0], apiResult.ratio[1]);
        const actMin = Math.min(fromPoint.frequency, toPoint.frequency);
        const actMax = Math.max(fromPoint.frequency, toPoint.frequency);
        anomalyReasons.push(
          `API返回频率值与实际不符: API [${apiMin}, ${apiMax}], 实际 [${actMin}, ${actMax}]`
        );
      }
    } else if (apiResult.isHarmonic) {
      anomalyReasons.push('API判定为谐波但未返回ratio数据');
    }

    const isAnomaly = anomalyReasons.length > 0;
    if (isAnomaly) {
      anomalies++;
    } else {
      passed++;
    }

    edgeResults.push({
      edge,
      fromPoint,
      toPoint,
      expectedRatio: edge.frequencyRatio,
      actualRatio,
      frequencyFrom: fromPoint.frequency,
      frequencyTo: toPoint.frequency,
      apiResult,
      isAnomaly,
      anomalyReasons
    });
  }

  return {
    levelId: level.id,
    levelName: level.name,
    creatureName: level.creatureName,
    totalEdges: level.edges.length,
    passedEdges: passed,
    anomalyEdges: anomalies,
    edgeResults
  };
}

function generateTextReport(report: DebugReport): string {
  const lines: string[] = [];
  const separator = '═'.repeat(80);
  const thinSep = '─'.repeat(80);

  lines.push(separator);
  lines.push('  星脉自测沙盒 - 调试报告');
  lines.push(separator);
  lines.push(`生成时间: ${report.generatedAt}`);
  lines.push(`服务地址: ${report.serverUrl}`);
  lines.push(`服务状态: ${report.serverReachable ? '✅ 可访问' : '❌ 不可访问'}`);
  lines.push('');

  lines.push('【总览统计】');
  lines.push(thinSep);
  lines.push(`  关卡总数: ${report.totalLevels}`);
  lines.push(`  星脉总数: ${report.totalEdges}`);
  lines.push(`  通过数量: ${report.totalPassed}  (${((report.totalPassed / report.totalEdges) * 100).toFixed(1)}%)`);
  lines.push(`  异常数量: ${report.totalAnomalies}  (${((report.totalAnomalies / report.totalEdges) * 100).toFixed(1)}%)`);
  lines.push('');

  for (const levelReport of report.levelReports) {
    lines.push(separator);
    lines.push(`【关卡 ${levelReport.levelId}: ${levelReport.levelName} (${levelReport.creatureName})】`);
    lines.push(thinSep);
    lines.push(`  星脉总数: ${levelReport.totalEdges}`);
    lines.push(`  通过: ${levelReport.passedEdges} | 异常: ${levelReport.anomalyEdges}`);
    lines.push('');

    for (const result of levelReport.edgeResults) {
      const status = result.isAnomaly ? '❌' : '✅';
      const fromName = result.fromPoint.name || result.fromPoint.id;
      const toName = result.toPoint.name || result.toPoint.id;

      lines.push(`  ${status} ${result.edge.from} → ${result.edge.to}  (${fromName} → ${toName})`);
      lines.push(`     频率: ${result.frequencyFrom} : ${result.frequencyTo}`);

      const expSimp = simplifyRatio(result.expectedRatio);
      lines.push(`     预设比例: ${result.expectedRatio[0]}:${result.expectedRatio[1]}  (最简: ${expSimp[0]}:${expSimp[1]})`);

      if (result.actualRatio) {
        const actSimp = simplifyRatio(result.actualRatio);
        lines.push(`     实际比例: ${result.actualRatio[0]}:${result.actualRatio[1]}  (最简: ${actSimp[0]}:${actSimp[1]})`);
      } else {
        lines.push(`     实际比例: 无法计算`);
      }

      lines.push(`     API结果: ${JSON.stringify(result.apiResult)}`);

      if (result.anomalyReasons.length > 0) {
        lines.push(`     异常原因:`);
        for (const reason of result.anomalyReasons) {
          lines.push(`       ⚠ ${reason}`);
        }
      }
      lines.push('');
    }
  }

  lines.push(separator);
  lines.push('  报告结束');
  lines.push(separator);

  return lines.join('\n');
}

function generateJsonReport(report: DebugReport): string {
  return JSON.stringify(report, null, 2);
}

async function main() {
  console.log('\n🌟 星脉自测沙盒启动中...\n');

  const levelsData = loadLevels();
  if (levelsData.levels.length === 0) {
    console.error('❌ 没有找到任何关卡数据');
    process.exit(1);
  }

  console.log(`📋 已加载 ${levelsData.levels.length} 个关卡`);

  console.log(`🔍 检查服务端连接 (${SERVER_URL})...`);
  const serverReachable = await checkServerHealth();
  console.log(`   ${serverReachable ? '✅ 服务端可访问' : '❌ 服务端不可访问，将继续执行但API调用会失败'}\n`);

  const levelReports: LevelTestReport[] = [];
  let totalEdges = 0;
  let totalPassed = 0;
  let totalAnomalies = 0;

  for (const level of levelsData.levels) {
    console.log(`🔬 正在测试关卡 ${level.id}: ${level.name}...`);
    const report = await testLevel(level);
    levelReports.push(report);
    totalEdges += report.totalEdges;
    totalPassed += report.passedEdges;
    totalAnomalies += report.anomalyEdges;
    console.log(`   ✅ 通过: ${report.passedEdges} | ❌ 异常: ${report.anomalyEdges} / ${report.totalEdges}`);
  }

  const debugReport: DebugReport = {
    generatedAt: new Date().toISOString(),
    serverUrl: SERVER_URL,
    serverReachable,
    totalLevels: levelReports.length,
    totalEdges,
    totalPassed,
    totalAnomalies,
    levelReports
  };

  console.log('\n📝 生成调试报告...');

  const textReport = generateTextReport(debugReport);
  const jsonReport = generateJsonReport(debugReport);

  const reportDir = path.resolve(process.cwd(), 'reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const textReportPath = path.join(reportDir, `starmap-debug-${timestamp}.txt`);
  const jsonReportPath = path.join(reportDir, `starmap-debug-${timestamp}.json`);

  fs.writeFileSync(textReportPath, textReport, 'utf-8');
  fs.writeFileSync(jsonReportPath, jsonReport, 'utf-8');

  console.log(`\n📄 文本报告已保存: ${textReportPath}`);
  console.log(`📄 JSON报告已保存: ${jsonReportPath}`);

  console.log('\n' + textReport);

  if (totalAnomalies > 0) {
    console.log(`\n⚠ 发现 ${totalAnomalies} 个异常星脉，请查看详细报告`);
    process.exit(1);
  } else {
    console.log('\n🎉 所有星脉测试通过！');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('❌ 自测沙盒运行出错:', err);
  process.exit(1);
});
