import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import fs from "fs";
import { pipeline, PassThrough } from "stream";
import { promisify } from "util";

/**
 * 工具函数类 - 格式化相关功能
 */
export class FormatUtils {
  /**
   * 格式化文件大小
   */
  static formatFileSize(bytes, options = {}) {
    const { showBoth = true, precision = 2, compact = false } = options;

    if (bytes === 0) return "0 Bytes";
    if (bytes < 0) return "Invalid size";

    const binaryUnits = ["Bytes", "KiB", "MiB", "GiB", "TiB", "PiB"];
    const binaryBase = 1024;

    const decimalUnits = ["Bytes", "KB", "MB", "GB", "TB", "PB"];
    const decimalBase = 1000;

    const formatWithUnits = (bytes, base, units) => {
      if (bytes < base) return `${bytes} ${units[0]}`;
      const i = Math.floor(Math.log(bytes) / Math.log(base));
      const size = (bytes / Math.pow(base, i)).toFixed(precision);
      return `${size} ${units[i]}`;
    };

    const binaryFormat = formatWithUnits(bytes, binaryBase, binaryUnits);

    if (showBoth && bytes >= 1024) {
      const decimalFormat = formatWithUnits(bytes, decimalBase, decimalUnits);
      return compact
        ? `${binaryFormat} (${decimalFormat})`
        : `${binaryFormat} (${decimalFormat})`;
    }

    return binaryFormat;
  }

  /**
   * 格式化速度
   */
  static formatSpeed(bytesPerSecond, options = {}) {
    const { showBoth = false, precision = 2 } = options;

    if (bytesPerSecond === 0) return "0 B/s";

    const speedText = this.formatFileSize(bytesPerSecond, {
      showBoth,
      precision,
      compact: true,
    });
    return speedText.replace(/([KMGTPE]?i?B)/, "$1/s");
  }

  /**
   * 格式化时间
   */
  static formatDuration(seconds, compact = true) {
    if (seconds < 0) return "Invalid duration";
    if (seconds === 0) return "0s";

    const units = [
      { name: "day", seconds: 86400, short: "d" },
      { name: "hour", seconds: 3600, short: "h" },
      { name: "minute", seconds: 60, short: "m" },
      { name: "second", seconds: 1, short: "s" },
    ];

    const parts = [];
    let remaining = Math.floor(seconds);

    for (const unit of units) {
      const count = Math.floor(remaining / unit.seconds);
      if (count > 0) {
        if (compact) {
          parts.push(`${count}${unit.short}`);
        } else {
          const unitName = count === 1 ? unit.name : unit.name + "s";
          parts.push(`${count} ${unitName}`);
        }
        remaining %= unit.seconds;
      }
    }

    if (parts.length === 0) {
      return compact ? "0s" : "0 seconds";
    }

    return compact ? parts.slice(0, 3).join(" ") : parts.join(", ");
  }

  /**
   * 睡眠函数
   */
  static sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * 文件完整性验证类
 */
export class FileIntegrityChecker {
  constructor(expectedSize) {
    this.expectedSize = expectedSize;
  }

  verify(filepath) {
    const results = {
      exists: false,
      sizeMatch: false,
      actualSize: 0,
      errors: [],
    };

    try {
      if (!fs.existsSync(filepath)) {
        results.errors.push("File does not exist");
        return results;
      }
      results.exists = true;

      const stats = fs.statSync(filepath);
      results.actualSize = stats.size;
      results.sizeMatch = stats.size === this.expectedSize;

      if (!results.sizeMatch) {
        const expected = FormatUtils.formatFileSize(this.expectedSize);
        const actual = FormatUtils.formatFileSize(results.actualSize);
        results.errors.push(
          `Size mismatch: expected ${expected}, got ${actual}`
        );
      }
    } catch (error) {
      results.errors.push(`Verification error: ${error.message}`);
    }

    return results;
  }
}

/**
 * 日志管理类
 */
export class Logger {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    this.logStream = fs.createWriteStream(logFilePath, { flags: "a" });
  }

  writeLog(message, level = "INFO") {
    const logMessage = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    this.logStream.write(logMessage);
  }

  info(message) {
    console.log(message);
    this.writeLog(message, "INFO");
  }

  error(message) {
    console.error(message);
    this.writeLog(message, "ERROR");
  }

  debug(message) {
    this.writeLog(message, "DEBUG");
  }

  close() {
    this.logStream.end();
  }
}

/**
 * 进度跟踪类
 */
export class ProgressTracker {
  constructor(concurrency, totalSize, logger) {
    this.concurrency = concurrency;
    this.totalSize = totalSize;
    this.logger = logger;
    this.startTime = Date.now();

    // 进度跟踪数组
    this.downloadedPerPart = new Array(concurrency).fill(0);
    this.partStatus = new Array(concurrency).fill("pending");
    this.partStartTime = new Array(concurrency).fill(0);
    this.partExpectedSizes = new Array(concurrency).fill(0);
    this.partRetryCount = new Array(concurrency).fill(0);
    this.partSpeeds = new Array(concurrency).fill(0);

    // 新增：用于更准确的速度计算
    this.partLastUpdateTime = new Array(concurrency).fill(0);
    this.partLastBytes = new Array(concurrency).fill(0);
    this.partSpeedHistory = new Array(concurrency).fill().map(() => []);
    this.speedHistorySize = 10; // 保留最近10次速度记录

    // 全局速度跟踪
    this.globalSpeedHistory = [];
    this.lastGlobalUpdateTime = Date.now();
    this.lastGlobalBytes = 0;

    this.progressInterval = null;
  }

  updatePartProgress(partIndex, downloaded, speed = 0) {
    const currentTime = Date.now();
    const previousDownloaded = this.downloadedPerPart[partIndex];

    this.downloadedPerPart[partIndex] = downloaded;

    // 如果提供了速度参数，直接使用
    if (speed > 0) {
      this.partSpeeds[partIndex] = speed;
      this._updatePartSpeedHistory(partIndex, speed);
    } else {
      // 否则根据下载进度计算速度
      const timeDiff =
        currentTime -
        (this.partLastUpdateTime[partIndex] || currentTime - 1000);
      const bytesDiff = downloaded - (this.partLastBytes[partIndex] || 0);

      if (timeDiff > 0 && bytesDiff >= 0) {
        const calculatedSpeed = (bytesDiff / timeDiff) * 1000;
        this.partSpeeds[partIndex] = calculatedSpeed;
        this._updatePartSpeedHistory(partIndex, calculatedSpeed);
      }
    }

    // 更新历史记录
    this.partLastUpdateTime[partIndex] = currentTime;
    this.partLastBytes[partIndex] = downloaded;

    // 更新全局速度历史
    this._updateGlobalSpeedHistory();
  }

  /**
   * 更新单个线程的速度历史记录
   */
  _updatePartSpeedHistory(partIndex, speed) {
    if (!this.partSpeedHistory[partIndex]) {
      this.partSpeedHistory[partIndex] = [];
    }

    this.partSpeedHistory[partIndex].push({
      speed,
      timestamp: Date.now(),
    });

    // 保持历史记录在指定大小内
    if (this.partSpeedHistory[partIndex].length > this.speedHistorySize) {
      this.partSpeedHistory[partIndex].shift();
    }
  }

  /**
   * 更新全局速度历史
   */
  _updateGlobalSpeedHistory() {
    const currentTime = Date.now();
    const totalDownloaded = this.getTotalDownloaded();

    // 每秒更新一次全局速度历史
    if (currentTime - this.lastGlobalUpdateTime >= 1000) {
      const timeDiff = currentTime - this.lastGlobalUpdateTime;
      const bytesDiff = totalDownloaded - this.lastGlobalBytes;

      if (timeDiff > 0) {
        const globalSpeed = (bytesDiff / timeDiff) * 1000;
        this.globalSpeedHistory.push({
          speed: globalSpeed,
          timestamp: currentTime,
        });

        // 保持全局速度历史在合理范围内（最近30秒）
        const thirtySecondsAgo = currentTime - 30000;
        this.globalSpeedHistory = this.globalSpeedHistory.filter(
          (record) => record.timestamp > thirtySecondsAgo
        );

        this.lastGlobalUpdateTime = currentTime;
        this.lastGlobalBytes = totalDownloaded;
      }
    }
  }

  /**
   * 获取单个线程的平均速度（基于历史记录）
   */
  getPartAverageSpeed(partIndex) {
    const history = this.partSpeedHistory[partIndex];
    if (!history || history.length === 0) {
      return this.partSpeeds[partIndex] || 0;
    }

    // 计算最近几次的平均速度
    const recentHistory = history.slice(-5); // 最近5次记录
    const avgSpeed =
      recentHistory.reduce((sum, record) => sum + record.speed, 0) /
      recentHistory.length;
    return avgSpeed;
  }

  /**
   * 获取所有活跃线程的综合速度信息
   */
  getActiveThreadsSpeed() {
    const currentTime = Date.now();
    const recentThreshold = 5000; // 5秒内有更新的被认为是活跃的

    let activeThreadsSpeed = 0;
    let activeThreadsCount = 0;
    let totalCurrentSpeed = 0;
    const activeSpeedData = [];

    for (let i = 0; i < this.concurrency; i++) {
      const lastUpdate = this.partLastUpdateTime[i];
      const isActive =
        lastUpdate > 0 && currentTime - lastUpdate < recentThreshold;
      const currentSpeed = this.partSpeeds[i] || 0;
      const avgSpeed = this.getPartAverageSpeed(i);

      totalCurrentSpeed += currentSpeed;

      if (isActive && currentSpeed > 0) {
        activeThreadsSpeed += avgSpeed;
        activeThreadsCount++;
        activeSpeedData.push({
          index: i,
          currentSpeed,
          avgSpeed,
          status: this.partStatus[i],
        });
      }
    }

    return {
      activeSpeed: activeThreadsSpeed,
      activeCount: activeThreadsCount,
      totalCurrentSpeed,
      averagePerActiveThread:
        activeThreadsCount > 0 ? activeThreadsSpeed / activeThreadsCount : 0,
      activeThreadsDetails: activeSpeedData,
    };
  }

  /**
   * 获取全局平均速度（基于历史记录）
   */
  getGlobalAverageSpeed() {
    if (this.globalSpeedHistory.length === 0) {
      const elapsedTime = (Date.now() - this.startTime) / 1000;
      return elapsedTime > 0 ? this.getTotalDownloaded() / elapsedTime : 0;
    }

    // 计算最近的全局平均速度
    const recentHistory = this.globalSpeedHistory.slice(-10); // 最近10次记录
    const avgSpeed =
      recentHistory.reduce((sum, record) => sum + record.speed, 0) /
      recentHistory.length;
    return avgSpeed;
  }

  /**
   * 计算基于多种方法的ETA
   */
  calculateETA() {
    const totalDownloaded = this.getTotalDownloaded();
    const remaining = this.totalSize - totalDownloaded;

    if (remaining <= 0) return 0;

    const activeThreadsInfo = this.getActiveThreadsSpeed();
    const globalAvgSpeed = this.getGlobalAverageSpeed();
    const elapsedTime = (Date.now() - this.startTime) / 1000;
    const overallAvgSpeed = elapsedTime > 0 ? totalDownloaded / elapsedTime : 0;

    // 方法1：基于当前活跃线程的速度
    const etaByActiveThreads =
      activeThreadsInfo.activeSpeed > 0
        ? remaining / activeThreadsInfo.activeSpeed
        : Infinity;

    // 方法2：基于全局平均速度（最近记录）
    const etaByGlobalAvg =
      globalAvgSpeed > 0 ? remaining / globalAvgSpeed : Infinity;

    // 方法3：基于整体平均速度
    const etaByOverallAvg =
      overallAvgSpeed > 0 ? remaining / overallAvgSpeed : Infinity;

    // 选择最合理的ETA：优先使用活跃线程速度，然后是全局平均，最后是整体平均
    let finalETA;
    let etaMethod;

    if (
      activeThreadsInfo.activeCount >= 2 &&
      etaByActiveThreads < Infinity &&
      etaByActiveThreads > 0
    ) {
      // 如果有足够的活跃线程，使用活跃线程速度
      finalETA = etaByActiveThreads;
      etaMethod = `active(${activeThreadsInfo.activeCount})`;
    } else if (etaByGlobalAvg < Infinity && etaByGlobalAvg > 0) {
      // 否则使用全局平均速度
      finalETA = etaByGlobalAvg;
      etaMethod = "global";
    } else if (etaByOverallAvg < Infinity && etaByOverallAvg > 0) {
      // 最后使用整体平均速度
      finalETA = etaByOverallAvg;
      etaMethod = "overall";
    } else {
      finalETA = 0;
      etaMethod = "unknown";
    }

    return {
      eta: finalETA,
      method: etaMethod,
      activeThreads: activeThreadsInfo.activeCount,
      activeSpeed: activeThreadsInfo.activeSpeed,
      globalAvgSpeed,
      overallAvgSpeed,
      details: {
        etaByActiveThreads,
        etaByGlobalAvg,
        etaByOverallAvg,
      },
    };
  }

  updatePartStatus(partIndex, status) {
    this.partStatus[partIndex] = status;
  }

  setPartExpectedSize(partIndex, size) {
    this.partExpectedSizes[partIndex] = size;
  }

  incrementRetryCount(partIndex) {
    this.partRetryCount[partIndex]++;
  }

  setPartStartTime(partIndex) {
    this.partStartTime[partIndex] = Date.now();
  }

  updateDisplay() {
    const totalDownloaded = this.getTotalDownloaded();
    const totalPercent =
      this.totalSize > 0
        ? ((totalDownloaded / this.totalSize) * 100).toFixed(2)
        : "0.00";

    const elapsedTime = (Date.now() - this.startTime) / 1000;
    const overallSpeed = elapsedTime > 0 ? totalDownloaded / elapsedTime : 0;

    // 使用新的ETA计算方法
    const etaInfo = this.calculateETA();
    const activeThreadsInfo = this.getActiveThreadsSpeed();

    const completed = this.partStatus.filter((s) =>
      s.includes("completed")
    ).length;
    const downloading = this.partStatus.filter((s) =>
      s.includes("downloading")
    ).length;
    const pending = this.partStatus.filter((s) => s === "pending").length;
    const retrying = this.partStatus.filter((s) =>
      s.includes("retrying")
    ).length;

    const totalRetries = this.partRetryCount.reduce((a, b) => a + b, 0);
    const maxRetries = Math.max(...this.partRetryCount);

    // 格式化ETA显示
    const etaDisplay =
      etaInfo.eta > 0 && etaInfo.eta < Infinity
        ? `${FormatUtils.formatDuration(etaInfo.eta)} (${etaInfo.method})`
        : "calculating...";

    process.stdout.write("\r\x1b[K");
    process.stdout.write(
      `Progress: ${totalPercent}% (${FormatUtils.formatFileSize(
        totalDownloaded,
        { compact: true }
      )}/${FormatUtils.formatFileSize(this.totalSize, { compact: true })}) | ` +
        `Overall: ${FormatUtils.formatSpeed(overallSpeed)} | ` +
        `Active: ${FormatUtils.formatSpeed(activeThreadsInfo.activeSpeed)} (${
          activeThreadsInfo.activeCount
        }/${this.concurrency} threads) | ` +
        `Current: ${FormatUtils.formatSpeed(
          activeThreadsInfo.totalCurrentSpeed
        )} | ` +
        `ETA: ${etaDisplay} | ` +
        `Parts [✓${completed} ↓${downloading} ⏸${pending} ⟲${retrying}] | ` +
        `Retries: ${totalRetries} (max: ${maxRetries})`
    );
  }

  startProgressDisplay() {
    this.progressInterval = setInterval(() => this.updateDisplay(), 500);
  }

  stopProgressDisplay() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  getTotalDownloaded() {
    return this.downloadedPerPart.reduce((a, b) => a + b, 0);
  }

  getTotalRetries() {
    return this.partRetryCount.reduce((a, b) => a + b, 0);
  }

  getMaxRetries() {
    return Math.max(...this.partRetryCount);
  }

  getAverageSpeed() {
    const elapsedTime = (Date.now() - this.startTime) / 1000;
    return elapsedTime > 0 ? this.getTotalDownloaded() / elapsedTime : 0;
  }

  getTotalTime() {
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * 获取详细的速度统计信息
   */
  getSpeedStats() {
    const activeThreadsInfo = this.getActiveThreadsSpeed();
    const etaInfo = this.calculateETA();

    return {
      overall: this.getAverageSpeed(),
      active: activeThreadsInfo.activeSpeed,
      current: activeThreadsInfo.totalCurrentSpeed,
      global: this.getGlobalAverageSpeed(),
      activeCount: activeThreadsInfo.activeCount,
      eta: etaInfo,
      perThread: activeThreadsInfo.activeThreadsDetails,
    };
  }
}

/**
 * S3多线程下载器主类
 */
export class S3MultiThreadDownloader {
  constructor(config = {}) {
    this.bucketName = config.bucketName || "";
    this.region = config.region || "ap-east-1";
    this.endpoint = config.endpoint || "";
    this.credentials = config.credentials || {};
    this.concurrency = config.concurrency || 10;
    this.downloadDir = config.downloadDir || path.join(process.cwd(), "files");
    this.objectKey = config.objectKey || "";
    this.localFileName = "";
    if (this.objectKey) {
      this.setObjectKey(this.objectKey);
    }

    // 初始化S3客户端
    this.s3Client = new S3Client({
      region: this.region,
      credentials: this.credentials,
      endpoint: this.endpoint,
      forcePathStyle: true,
    });

    // 创建下载目录
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);

    const logFileName = config.logFileName || `download_log_${timestamp}.txt`;
    const logFile = path.join(this.downloadDir, logFileName);
    this.logger = new Logger(logFile);

    // 工具函数
    this.streamPipeline = promisify(pipeline);

    // 下载状态
    this.fileSize = 0;
    this.progressTracker = null;
  }

  /**
   * 设置对象键
   */
  setObjectKey(objectKey) {
    // 处理对象键格式
    if (this.bucketName && objectKey.startsWith(this.bucketName + "/")) {
      objectKey = objectKey.slice(this.bucketName.length + 1);
    }

    this.objectKey = objectKey;
    this.localFileName = objectKey.split("/").pop();
    return this;
  }

  /**
   * 获取文件大小
   */
  async getFileSize() {
    const headCommand = new HeadObjectCommand({
      Bucket: this.bucketName,
      Key: this.objectKey,
    });
    const response = await this.s3Client.send(headCommand);
    return parseInt(response.ContentLength, 10);
  }

  /**
   * 获取分片恢复信息
   */
  getPartResumeInfo(tempFile, expectedSize) {
    try {
      if (fs.existsSync(tempFile)) {
        const stats = fs.statSync(tempFile);
        const currentSize = stats.size;

        if (currentSize > expectedSize) {
          this.logger.error(
            `Part file ${tempFile} is larger than expected (${FormatUtils.formatFileSize(
              currentSize
            )} > ${FormatUtils.formatFileSize(expectedSize)}), will recreate`
          );
          fs.unlinkSync(tempFile);
          return { resumeBytes: 0, isValid: false };
        }

        if (currentSize === expectedSize) {
          return { resumeBytes: currentSize, isValid: true, isComplete: true };
        }

        return { resumeBytes: currentSize, isValid: true, isComplete: false };
      }
      return { resumeBytes: 0, isValid: true, isComplete: false };
    } catch (error) {
      this.logger.error(
        `Failed to get resume info for ${tempFile}: ${error.message}`
      );
      return { resumeBytes: 0, isValid: false };
    }
  }

  /**
   * 下载单个分片
   */
  async downloadRange(originalStart, originalEnd, idx) {
    const tempFile = path.join(
      this.downloadDir,
      `${this.localFileName}.part${idx}`
    );
    const expectedSize = originalEnd - originalStart + 1;
    this.progressTracker.setPartExpectedSize(idx, expectedSize);

    while (true) {
      this.progressTracker.incrementRetryCount(idx);
      this.progressTracker.setPartStartTime(idx);

      try {
        const resumeInfo = this.getPartResumeInfo(tempFile, expectedSize);
        if (!resumeInfo.isValid) {
          this.logger.error(`Invalid part file ${tempFile}, starting fresh`);
        }

        const resumeBytes = resumeInfo.resumeBytes;
        const actualStart = originalStart + resumeBytes;
        const remainingBytes = originalEnd - actualStart + 1;

        if (resumeInfo.isComplete) {
          this.progressTracker.updatePartStatus(
            idx,
            "completed (already exists)"
          );
          this.progressTracker.updatePartProgress(idx, expectedSize);
          this.logger.info(
            `Part ${idx}: Already completed (${FormatUtils.formatFileSize(
              expectedSize
            )}), skipping`
          );
          return tempFile;
        }

        if (remainingBytes <= 0) {
          this.progressTracker.updatePartStatus(idx, "completed (resumed)");
          this.progressTracker.updatePartProgress(idx, expectedSize);
          this.logger.info(
            `Part ${idx}: Already completed through resume, skipping`
          );
          return tempFile;
        }

        const resumePercentage = ((resumeBytes / expectedSize) * 100).toFixed(
          1
        );
        this.progressTracker.updatePartStatus(
          idx,
          `downloading (attempt ${this.progressTracker.partRetryCount[idx]}, ${resumePercentage}% resume)`
        );

        this.logger.debug(
          `Part ${idx}: Resume download from byte ${actualStart} to ${originalEnd} ` +
            `(${FormatUtils.formatFileSize(
              remainingBytes
            )} remaining of ${FormatUtils.formatFileSize(
              expectedSize
            )} total), ` +
            `attempt ${this.progressTracker.partRetryCount[idx]}`
        );

        const getCommand = new GetObjectCommand({
          Bucket: this.bucketName,
          Key: this.objectKey,
          Range: `bytes=${actualStart}-${originalEnd}`,
        });

        const response = await this.s3Client.send(getCommand);
        const responseContentLength = parseInt(
          response.ContentLength || "0",
          10
        );

        if (responseContentLength !== remainingBytes) {
          this.logger.error(
            `Part ${idx}: Expected ${remainingBytes} bytes, but received ${responseContentLength} bytes from server`
          );
        }

        const passThrough = new PassThrough();
        this.progressTracker.updatePartProgress(idx, resumeBytes);

        let lastProgressTime = Date.now();
        let lastBytes = resumeBytes;
        let currentSessionDownloaded = 0;

        response.Body.on("data", (chunk) => {
          currentSessionDownloaded += chunk.length;
          const currentDownloaded = resumeBytes + currentSessionDownloaded;

          const currentTime = Date.now();
          if (currentTime - lastProgressTime > 1000) {
            const timeDiff = currentTime - lastProgressTime;
            const bytesDiff = currentDownloaded - lastBytes;
            const speed = (bytesDiff / timeDiff) * 1000;

            this.progressTracker.updatePartProgress(
              idx,
              currentDownloaded,
              speed
            );

            const partProgress = (
              (currentDownloaded / expectedSize) *
              100
            ).toFixed(1);

            this.logger.debug(
              `Part ${idx}: ${partProgress}% complete ` +
                `(${FormatUtils.formatFileSize(
                  currentDownloaded
                )} / ${FormatUtils.formatFileSize(expectedSize)}) ` +
                `at ${FormatUtils.formatSpeed(speed)} ` +
                `[Session: ${FormatUtils.formatFileSize(
                  currentSessionDownloaded
                )}, Resume: ${FormatUtils.formatFileSize(resumeBytes)}]`
            );

            lastProgressTime = currentTime;
            lastBytes = currentDownloaded;
          }
        });

        response.Body.on("error", (error) => {
          this.progressTracker.updatePartProgress(
            idx,
            resumeBytes + currentSessionDownloaded,
            0
          );
          this.logger.error(`Stream error in part ${idx}: ${error.message}`);
          this.progressTracker.updatePartStatus(
            idx,
            `stream error: ${error.message}`
          );
        });

        const writeStream = fs.createWriteStream(tempFile, {
          flags: resumeBytes > 0 ? "a" : "w",
        });

        await this.streamPipeline(response.Body, passThrough, writeStream);

        const finalSize = fs.statSync(tempFile).size;
        if (finalSize !== expectedSize) {
          throw new Error(
            `Part ${idx} final size mismatch: expected ${FormatUtils.formatFileSize(
              expectedSize
            )}, got ${FormatUtils.formatFileSize(finalSize)} ` +
              `(original: ${FormatUtils.formatFileSize(
                resumeBytes
              )}, downloaded: ${FormatUtils.formatFileSize(
                currentSessionDownloaded
              )})`
          );
        }

        this.progressTracker.updatePartStatus(idx, "completed");
        this.progressTracker.updatePartProgress(idx, expectedSize, 0);

        const partTime = (
          (Date.now() - this.progressTracker.partStartTime[idx]) /
          1000
        ).toFixed(1);
        const partSpeed =
          (currentSessionDownloaded /
            (Date.now() - this.progressTracker.partStartTime[idx])) *
          1000;

        this.logger.debug(
          `Part ${idx} completed successfully in ${partTime}s at average ${FormatUtils.formatSpeed(
            partSpeed
          )} ` +
            `(total: ${FormatUtils.formatFileSize(
              expectedSize
            )}, resumed: ${FormatUtils.formatFileSize(resumeBytes)}, ` +
            `downloaded: ${FormatUtils.formatFileSize(
              currentSessionDownloaded
            )}, attempts: ${this.progressTracker.partRetryCount[idx]})`
        );

        return tempFile;
      } catch (error) {
        this.progressTracker.updatePartProgress(
          idx,
          this.getPartResumeInfo(tempFile, expectedSize).resumeBytes,
          0
        );
        const currentResumeInfo = this.getPartResumeInfo(
          tempFile,
          expectedSize
        );
        const currentResumeBytes = currentResumeInfo.resumeBytes;

        this.logger.error(
          `Error downloading part ${idx} (attempt ${this.progressTracker.partRetryCount[idx]}): ${error.message}. ` +
            `Preserved: ${FormatUtils.formatFileSize(
              currentResumeBytes
            )} / ${FormatUtils.formatFileSize(expectedSize)} ` +
            `(${((currentResumeBytes / expectedSize) * 100).toFixed(1)}%)`
        );

        const resumePercentage = (
          (currentResumeBytes / expectedSize) *
          100
        ).toFixed(1);
        this.progressTracker.updatePartStatus(
          idx,
          `retrying now (attempt ${this.progressTracker.partRetryCount[idx]}, ${resumePercentage}% saved)`
        );

        this.logger.debug(
          `Part ${idx}: Retrying immediately (attempt ${
            this.progressTracker.partRetryCount[idx] + 1
          }) ` +
            `from ${FormatUtils.formatFileSize(
              currentResumeBytes
            )} (${resumePercentage}% complete)`
        );

        await FormatUtils.sleep(1000);
      }
    }
  }

  /**
   * 合并文件
   */
  async mergeFiles(parts) {
    this.logger.info("\nMerging and verifying parts...");

    // 验证所有分片
    for (let i = 0; i < parts.length; i++) {
      const partFile = parts[i];
      const expectedSize = this.progressTracker.partExpectedSizes[i];
      const checker = new FileIntegrityChecker(expectedSize);
      const verification = checker.verify(partFile);

      if (!verification.exists || !verification.sizeMatch) {
        const errors = verification.errors.join(", ");
        throw new Error(
          `Part ${i} verification failed: ${errors}. File: ${partFile}`
        );
      }

      this.logger.debug(
        `Part ${i}: Size verified (${FormatUtils.formatFileSize(
          verification.actualSize
        )})`
      );
    }

    this.logger.info("All parts verified successfully. Starting merge...");

    const finalFilePath = path.join(this.downloadDir, this.localFileName);
    const writeStream = fs.createWriteStream(finalFilePath, { flags: "w" });
    let totalMergedBytes = 0;

    for (let i = 0; i < parts.length; i++) {
      const partFile = parts[i];
      this.logger.debug(`Merging part ${i + 1}/${parts.length}: ${partFile}`);
      process.stdout.write(`\rMerging parts: ${i + 1}/${parts.length}...`);

      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(partFile);

        readStream.on("data", (chunk) => {
          totalMergedBytes += chunk.length;
        });

        readStream.pipe(writeStream, { end: false });
        readStream.on("end", resolve);
        readStream.on("error", reject);
      });
    }

    writeStream.close();

    // 最终文件验证
    const finalChecker = new FileIntegrityChecker(this.fileSize);
    const finalVerification = finalChecker.verify(finalFilePath);

    if (!finalVerification.exists || !finalVerification.sizeMatch) {
      const errors = finalVerification.errors.join(", ");
      throw new Error(`Final file verification failed: ${errors}`);
    }

    this.logger.info(`✅ Final file verification passed:`);
    this.logger.info(`   📁 File: ${this.localFileName}`);
    this.logger.info(
      `   📊 Size: ${FormatUtils.formatFileSize(finalVerification.actualSize)}`
    );
    this.logger.info(`   🎯 Match: Perfect size match`);

    // 清理临时文件
    let cleanedFiles = 0;
    parts.forEach((file, idx) => {
      try {
        fs.unlinkSync(file);
        cleanedFiles++;
        this.logger.debug(`Cleaned up temporary file: ${file}`);
      } catch (e) {
        this.logger.error(
          `Warning: Could not delete temporary file ${file}: ${e.message}`
        );
      }
    });

    this.logger.info(
      `🧹 Cleaned up ${cleanedFiles}/${parts.length} temporary files.`
    );
  }

  /**
   * 🌟 启动下载的便捷方法（如果是在 config 中传了 objectKey）
   */
  async start() {
    if (!this.objectKey) {
      throw new Error(
        "Object key is required. Set it in config or use download(objectKey) method."
      );
    }
    return await this.download();
  }

  /**
   * 🌟 主下载方法支持可选参数
   */
  async download(objectKey = null) {
    // 🌟 如果传入了objectKey参数，则使用它；否则使用配置中的objectKey
    if (objectKey !== null) {
      this.setObjectKey(objectKey);
    } else if (!this.objectKey) {
      throw new Error(
        "Object key is required either in config or as parameter"
      );
    }

    try {
      this.fileSize = await this.getFileSize();
      this.progressTracker = new ProgressTracker(
        this.concurrency,
        this.fileSize,
        this.logger
      );

      this.logger.info(`📁 File: ${this.localFileName}`);
      this.logger.info(
        `📊 Size: ${FormatUtils.formatFileSize(
          this.fileSize
        )} (${this.fileSize.toLocaleString()} bytes)`
      );
      this.logger.info(`🧵 Concurrency: ${this.concurrency} threads`);
      this.logger.info(`🔄 Mode: Infinite retry with resume capability`);
      this.logger.info(`📋 Log file: ${this.logger.logFilePath}\n`);

      const partSize = Math.floor(this.fileSize / this.concurrency);

      let totalResumedBytes = 0;
      let completedParts = 0;
      let partialParts = 0;

      // 检查已有的分片文件
      for (let i = 0; i < this.concurrency; i++) {
        const tempFile = path.join(
          this.downloadDir,
          `${this.localFileName}.part${i}`
        );
        const start = i * partSize;
        const end =
          i === this.concurrency - 1 ? this.fileSize - 1 : start + partSize - 1;
        const expectedSize = end - start + 1;

        this.progressTracker.setPartExpectedSize(i, expectedSize);
        this.progressTracker.partRetryCount[i] = 0;

        const resumeInfo = this.getPartResumeInfo(tempFile, expectedSize);
        const resumeBytes = resumeInfo.resumeBytes;
        this.progressTracker.updatePartProgress(i, resumeBytes);
        totalResumedBytes += resumeBytes;

        if (resumeInfo.isComplete) {
          this.progressTracker.updatePartStatus(
            i,
            "completed (already exists)"
          );
          completedParts++;
          this.logger.info(
            `Part ${i}: ✅ Already completed (${FormatUtils.formatFileSize(
              resumeBytes
            )})`
          );
        } else if (resumeBytes > 0) {
          const resumePercentage = ((resumeBytes / expectedSize) * 100).toFixed(
            1
          );
          this.progressTracker.updatePartStatus(
            i,
            `resuming from ${resumePercentage}%`
          );
          partialParts++;
          this.logger.info(
            `Part ${i}: ⏸ Will resume from ${FormatUtils.formatFileSize(
              resumeBytes
            )} (${resumePercentage}%)`
          );
        } else {
          this.logger.debug(
            `Part ${i}: Will download ${FormatUtils.formatFileSize(
              expectedSize
            )} fresh`
          );
        }
      }

      if (totalResumedBytes > 0) {
        const resumePercentage = (
          (totalResumedBytes / this.fileSize) *
          100
        ).toFixed(2);
        this.logger.info(`\n📊 Resume Summary:`);
        this.logger.info(
          `  ✅ Completed parts: ${completedParts}/${this.concurrency}`
        );
        this.logger.info(
          `  ⏸ Partial parts: ${partialParts}/${this.concurrency}`
        );
        this.logger.info(
          `  💾 Already downloaded: ${FormatUtils.formatFileSize(
            totalResumedBytes
          )} (${resumePercentage}%)`
        );
        this.logger.info(
          `  📥 Remaining: ${FormatUtils.formatFileSize(
            this.fileSize - totalResumedBytes
          )}\n`
        );
      }

      const downloadPromises = [];
      const parts = new Array(this.concurrency);

      // 启动所有下载线程
      for (let i = 0; i < this.concurrency; i++) {
        const start = i * partSize;
        const end =
          i === this.concurrency - 1 ? this.fileSize - 1 : start + partSize - 1;

        downloadPromises.push(
          this.downloadRange(start, end, i)
            .then((file) => {
              parts[i] = file;
              return file;
            })
            .catch((error) => {
              this.logger.error(
                `Unexpected final error for part ${i}: ${error.message}`
              );
              throw error;
            })
        );

        if (i < this.concurrency - 1) {
          await FormatUtils.sleep(100);
        }
      }

      this.logger.info(
        "🚀 All downloads started with infinite retry mode...\n"
      );

      // 启动进度显示
      this.progressTracker.startProgressDisplay();

      try {
        await Promise.all(downloadPromises);
        this.progressTracker.stopProgressDisplay();
      } catch (error) {
        this.progressTracker.stopProgressDisplay();
        throw error;
      }

      console.log();
      this.logger.info("✅ All parts downloaded successfully!");

      await this.mergeFiles(parts);

      const totalTime = this.progressTracker.getTotalTime();
      const totalRetries = this.progressTracker.getTotalRetries();
      const maxRetries = this.progressTracker.getMaxRetries();
      const avgSpeed = this.progressTracker.getAverageSpeed();

      this.logger.info(`\n🎉 Download Complete!`);
      this.logger.info(`📁 File: ${this.localFileName}`);
      this.logger.info(`📊 Size: ${FormatUtils.formatFileSize(this.fileSize)}`);
      this.logger.info(
        `⏱️  Total time: ${FormatUtils.formatDuration(totalTime, false)}`
      );
      this.logger.info(
        `🔄 Total retries: ${totalRetries} (max per part: ${maxRetries})`
      );
      this.logger.info(
        `🚀 Average speed: ${FormatUtils.formatSpeed(avgSpeed)}`
      );
      this.logger.info(
        `💾 Saved to: ${path.join(this.downloadDir, this.localFileName)}`
      );
      this.logger.info(`📋 Log: ${this.logger.logFilePath}`);

      return {
        success: true,
        filePath: path.join(this.downloadDir, this.localFileName),
        fileSize: this.fileSize,
        totalTime: totalTime,
        avgSpeed: avgSpeed,
        totalRetries: totalRetries,
      };
    } catch (err) {
      this.logger.error(`❌ Download failed: ${err.message}`);
      this.logFinalStatus();
      throw err;
    } finally {
      this.logger.close();
    }
  }

  /**
   * 记录最终状态
   */
  logFinalStatus() {
    if (!this.progressTracker) return;

    this.logger.info("\n📊 Final Status Report:");
    let totalSaved = 0;
    let completedParts = 0;
    let totalRetries = this.progressTracker.getTotalRetries();

    this.progressTracker.partStatus.forEach((status, idx) => {
      const tempFile = path.join(
        this.downloadDir,
        `${this.localFileName}.part${idx}`
      );
      const expectedSize =
        this.progressTracker.partExpectedSizes[idx] ||
        Math.floor(this.fileSize / this.concurrency);
      const resumeInfo = this.getPartResumeInfo(tempFile, expectedSize);
      const savedBytes = resumeInfo.resumeBytes;
      const progress =
        expectedSize > 0
          ? ((savedBytes / expectedSize) * 100).toFixed(1)
          : "0.0";
      const retries = this.progressTracker.partRetryCount[idx];

      totalSaved += savedBytes;
      if (resumeInfo.isComplete) completedParts++;

      const statusLine = `Part ${idx}: ${progress}% (${FormatUtils.formatFileSize(
        savedBytes
      )}/${FormatUtils.formatFileSize(
        expectedSize
      )}) [${retries} retries] - ${status}`;
      this.logger.info(statusLine);
    });

    const totalProgress =
      this.fileSize > 0
        ? ((totalSaved / this.fileSize) * 100).toFixed(1)
        : "0.0";
    this.logger.info(
      `\n📈 Total Progress: ${totalProgress}% (${FormatUtils.formatFileSize(
        totalSaved
      )} saved)`
    );
    this.logger.info(
      `✅ Completed parts: ${completedParts}/${this.concurrency}`
    );
    this.logger.info(`🔄 Total retries: ${totalRetries}`);
    this.logger.info(
      `\n🔄 Run the script again to resume from current progress!`
    );
    this.logger.info(`💾 All partial downloads have been preserved.`);
  }

  /**
   * 获取下载状态信息
   */
  getStatus() {
    if (!this.progressTracker) {
      return null;
    }

    return {
      totalSize: this.fileSize,
      downloaded: this.progressTracker.getTotalDownloaded(),
      progress:
        this.fileSize > 0
          ? (
              (this.progressTracker.getTotalDownloaded() / this.fileSize) *
              100
            ).toFixed(2)
          : 0,
      speed: this.progressTracker.getAverageSpeed(),
      totalTime: this.progressTracker.getTotalTime(),
      retries: this.progressTracker.getTotalRetries(),
      partStatus: this.progressTracker.partStatus.map((status, idx) => ({
        index: idx,
        status,
        downloaded: this.progressTracker.downloadedPerPart[idx],
        expected: this.progressTracker.partExpectedSizes[idx],
        progress:
          this.progressTracker.partExpectedSizes[idx] > 0
            ? (
                (this.progressTracker.downloadedPerPart[idx] /
                  this.progressTracker.partExpectedSizes[idx]) *
                100
              ).toFixed(1)
            : 0,
        retries: this.progressTracker.partRetryCount[idx],
        speed: this.progressTracker.partSpeeds[idx],
      })),
    };
  }

  /**
   * 设置中断处理器
   */
  setupInterruptHandler() {
    process.on("SIGINT", () => {
      console.log("\n\n⚠️  Download interrupted by user");
      this.logger.info("Download interrupted by user - preserving progress");

      if (this.progressTracker) {
        this.progressTracker.stopProgressDisplay();

        console.log("\n📊 Current Progress:");
        let totalSaved = 0;
        let totalRetries = this.progressTracker.getTotalRetries();

        this.progressTracker.partStatus.forEach((status, idx) => {
          const tempFile = path.join(
            this.downloadDir,
            `${this.localFileName}.part${idx}`
          );
          const expectedSize =
            this.progressTracker.partExpectedSizes[idx] ||
            Math.floor(this.fileSize / this.concurrency);
          const resumeInfo = this.getPartResumeInfo(tempFile, expectedSize);
          const savedBytes = resumeInfo.resumeBytes;
          const progress =
            expectedSize > 0
              ? ((savedBytes / expectedSize) * 100).toFixed(1)
              : "0.0";
          const retries = this.progressTracker.partRetryCount[idx];

          totalSaved += savedBytes;

          const statusLine = `Part ${idx}: ${progress}% (${FormatUtils.formatFileSize(
            savedBytes,
            { compact: true }
          )}) [${retries} attempts] - ${status}`;
          console.log(statusLine);
          this.logger.info(statusLine);
        });

        const totalProgress =
          this.fileSize > 0
            ? ((totalSaved / this.fileSize) * 100).toFixed(1)
            : "0.0";
        console.log(
          `\n📈 Total saved: ${totalProgress}% (${FormatUtils.formatFileSize(
            totalSaved
          )})`
        );
        console.log(`🔄 Total attempts: ${totalRetries}`);
        console.log(
          `\n🔄 Restart the script to continue downloading from current progress!`
        );

        this.logger.info(`Total progress saved: ${totalProgress}%`);
        this.logger.info(`Total attempts made: ${totalRetries}`);
      }

      this.logger.close();
      process.exit(0);
    });
  }
}
