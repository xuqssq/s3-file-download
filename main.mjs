import {
  FormatUtils,
  FileIntegrityChecker,
  Logger,
  ProgressTracker,
  S3MultiThreadDownloader,
} from "./s3-downloader.mjs";
import path from "path";

async function main() {
  const downloader = new S3MultiThreadDownloader({
    bucketName: "flatfiles",
    region: "ap-east-1",
    endpoint: "https://files.polygon.io",
    credentials: {
      accessKeyId: "1805d9f5-8c9a-4061-ac1c-ef4f24df4234",
      secretAccessKey: "Mt51RZwAu3kmNBh4XZF6JUuYIifjt6Jf",
    },
    objectKey: "flatfiles/us_options_opra/quotes_v1/2025/06/2025-06-10.csv.gz",
    concurrency: 10, //线程数
    downloadDir: path.join(process.cwd(), "files"), //保存目录
  });

  downloader.setupInterruptHandler();

  try {
    console.log(`🚀 启动 ${downloader.concurrency} 线程下载器...`);
    console.log(`📋 日志文件: ${downloader.logger.logFilePath}\n`);
    const result = await downloader.start();

    console.log("🎉 下载成功完成!");
    console.log(`📁 文件路径: ${result.filePath}`);
    console.log(`📊 文件大小: ${FormatUtils.formatFileSize(result.fileSize)}`);
    console.log(
      `⏱️  总耗时: ${FormatUtils.formatDuration(result.totalTime, false)}`
    );
    console.log(`🚀 平均速度: ${FormatUtils.formatSpeed(result.avgSpeed)}`);
  } catch (error) {
    console.error(`❌ 下载失败: ${error.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
