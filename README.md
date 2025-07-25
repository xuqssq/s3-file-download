# S3 多线程下载器 📥

一个功能强大的 Node.js S3 多线程下载器，支持断点续传、无限重试、实时进度监控和智能速度计算。

## ✨ 主要特性

- 🚀 **多线程并发下载** - 可配置并发线程数，显著提升下载速度
- ⏸️ **断点续传** - 自动检测和恢复未完成的下载
- 🔄 **无限重试机制** - 网络中断时自动重试，保障下载完成
- 📊 **实时进度监控** - 详细的进度显示和速度统计
- 🧮 **智能速度计算** - 多种 ETA 算法，准确预估完成时间
- 📝 **详细日志记录** - 完整的下载过程记录
- ✅ **文件完整性验证** - 确保下载文件的完整性
- 🛡️ **优雅中断处理** - 支持 Ctrl+C 中断并保存进度

## 📦 安装依赖

```bash
npm install @aws-sdk/client-s3
```

## 🚀 快速开始

### 基础用法

```javascript
import { S3MultiThreadDownloader } from './s3-downloader.js';

const downloader = new S3MultiThreadDownloader({
  bucketName: "your-bucket-name",
  region: "us-east-1", 
  endpoint: "https://your-s3-endpoint.com",
  credentials: {
    accessKeyId: "your-access-key",
    secretAccessKey: "your-secret-key"
  },
  objectKey: "path/to/your/file.zip",
  concurrency: 10, // 并发线程数
  downloadDir: "./downloads" // 下载目录
});

// 启动下载
const result = await downloader.start();
console.log('下载完成:', result);
```

### 动态指定文件

```javascript
const downloader = new S3MultiThreadDownloader({
  bucketName: "my-bucket",
  // ... 其他配置
});

// 方法1: 在 download 方法中指定
await downloader.download("path/to/file1.zip");
await downloader.download("path/to/file2.tar.gz");

// 方法2: 使用 setObjectKey 方法
downloader.setObjectKey("path/to/file3.bin").start();
```

## ⚙️ 配置选项

```javascript
const config = {
  // 必需配置
  bucketName: "your-bucket",           // S3 存储桶名称
  credentials: {                       // S3 认证信息
    accessKeyId: "xxx",
    secretAccessKey: "xxx"
  },

  // 可选配置
  region: "us-east-1",                 // AWS 区域 (默认: ap-east-1)
  endpoint: "https://s3.amazonaws.com", // S3 端点 (可选)
  objectKey: "path/to/file",           // 对象键 (可在运行时指定)
  concurrency: 10,                     // 并发线程数 (默认: 10)
  downloadDir: "./downloads",          // 下载目录 (默认: ./files)
  logFileName: "custom_log.txt"        // 自定义日志文件名
};
```

## 📊 实时进度监控

下载过程中会显示详细的进度信息：

```
Progress: 45.32% (2.1 GB/4.6 GB) | Overall: 15.2 MB/s | Active: 18.7 MB/s (8/10 threads) | 
Current: 16.8 MB/s | ETA: 2m 14s (active) | Parts [✓3 ↓5 ⏸1 ⟲1] | Retries: 12 (max: 3)
```

图例说明：
- `✓` - 已完成的分片
- `↓` - 正在下载的分片
- `⏸` - 等待中的分片
- `⟲` - 重试中的分片

## 🔄 断点续传

下载器自动检测已存在的分片文件并从中断点继续：

```javascript
// 第一次运行 - 下载到 60% 时中断
await downloader.download("large-file.zip");

// 再次运行 - 自动从 60% 继续下载
await downloader.download("large-file.zip");
```

## 📝 日志管理

```javascript
// 日志文件自动生成，包含时间戳
// 格式：download_log_2024-01-15T10-30-45.txt

// 查看日志级别
downloader.logger.info("信息日志");
downloader.logger.error("错误日志");
downloader.logger.debug("调试日志");
```

## 🛡️ 错误处理

### 优雅中断

```javascript
// 设置中断处理器
downloader.setupInterruptHandler();

// 按 Ctrl+C 时会：
// 1. 停止所有下载线程
// 2. 显示当前进度
// 3. 保存已下载的分片
// 4. 输出恢复提示
```

### 异常处理

```javascript
try {
  const result = await downloader.start();
  console.log('下载成功:', result);
} catch (error) {
  console.error('下载失败:', error.message);

  // 查看详细状态
  const status = downloader.getStatus();
  console.log('当前进度:', status?.progress + '%');
}
```

## 📈 进度监控

### 获取下载状态

```javascript
const status = downloader.getStatus();
console.log(status);
/*
{
  totalSize: 4847392768,
  downloaded: 2198765432,
  progress: "45.32",
  speed: 15728640,
  totalTime: 139.7,
  retries: 12,
  partStatus: [
    {
      index: 0,
      status: "completed",
      downloaded: 484739276,
      expected: 484739276,
      progress: "100.0",
      retries: 1,
      speed: 0
    },
    // ... 其他分片状态
  ]
}
*/
```

### 速度统计

```javascript
// 获取详细速度信息
const speedStats = downloader.progressTracker.getSpeedStats();
console.log(speedStats);
/*
{
  overall: 15728640,      // 整体平均速度
  active: 18739200,       // 活跃线程速度
  current: 16777216,      // 当前瞬时速度
  global: 17825792,       // 全局平均速度
  activeCount: 8,         // 活跃线程数
  eta: {                  // ETA 信息
    eta: 134.5,
    method: "active",
    activeThreads: 8
  }
}
*/
```

## 🔧 工具类

### FormatUtils - 格式化工具

```javascript
import { FormatUtils } from './s3-downloader.js';

// 格式化文件大小
FormatUtils.formatFileSize(1024); 
// "1.00 KiB (1.02 KB)"

FormatUtils.formatFileSize(1024, { showBoth: false }); 
// "1.00 KiB"

// 格式化速度
FormatUtils.formatSpeed(1048576); 
// "1.00 MiB/s"

// 格式化时间
FormatUtils.formatDuration(3661); 
// "1h 1m 1s"

FormatUtils.formatDuration(3661, false); 
// "1 hour, 1 minute, 1 second"

// 睡眠函数
await FormatUtils.sleep(1000); // 等待 1 秒
```

### FileIntegrityChecker - 文件完整性验证

```javascript
import { FileIntegrityChecker } from './s3-downloader.js';

const checker = new FileIntegrityChecker(expectedSize);
const result = checker.verify(filePath);

console.log(result);
/*
{
  exists: true,
  sizeMatch: true,
  actualSize: 1048576,
  errors: []
}
*/
```

### Logger - 日志管理

```javascript
import { Logger } from './s3-downloader.js';

const logger = new Logger('./my-app.log');

logger.info('应用启动');
logger.error('发生错误');
logger.debug('调试信息');

// 记得关闭日志流
logger.close();
```

## 📋 完整示例

### 1. 基本下载示例

```javascript
import { S3MultiThreadDownloader, FormatUtils } from './s3-downloader.js';
import path from 'path';

async function basicDownload() {
  const downloader = new S3MultiThreadDownloader({
    bucketName: "my-data-bucket",
    region: "us-west-2",
    endpoint: "https://s3.us-west-2.amazonaws.com",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    // 在配置中指定文件
    objectKey: "datasets/2024/data.csv.gz",
    concurrency: 8,
    downloadDir: path.join(process.cwd(), "downloads")
  });

  downloader.setupInterruptHandler();

  try {
    const result = await downloader.start();
    console.log(`✅ 下载完成: ${result.filePath}`);
  } catch (error) {
    console.error(`❌ 下载失败: ${error.message}`);
  }
}

basicDownload();
```

### 2. 批量下载示例

```javascript
import { S3MultiThreadDownloader, FormatUtils } from './s3-downloader.js';
import path from 'path';

async function batchDownload() {
  const downloader = new S3MultiThreadDownloader({
    bucketName: "my-data-bucket",
    region: "us-west-2",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    concurrency: 16,
    downloadDir: path.join(process.cwd(), "downloads")
  });

  downloader.setupInterruptHandler();

  const files = [
    "datasets/2024/january/data.csv.gz",
    "datasets/2024/february/data.csv.gz", 
    "datasets/2024/march/data.csv.gz"
  ];

  for (const file of files) {
    try {
      console.log(`🚀 开始下载: ${file}`);
    
      const result = await downloader.download(file);
    
      console.log(`✅ 下载完成: ${file}`);
      console.log(`📊 大小: ${FormatUtils.formatFileSize(result.fileSize)}`);
      console.log(`⏱️ 耗时: ${FormatUtils.formatDuration(result.totalTime)}`);
      console.log(`🚀 平均速度: ${FormatUtils.formatSpeed(result.avgSpeed)}`);
      console.log(`🔄 重试次数: ${result.totalRetries}\n`);
    
    } catch (error) {
      console.error(`❌ 下载失败 ${file}: ${error.message}`);
    
      const status = downloader.getStatus();
      if (status) {
        console.log(`📊 当前进度: ${status.progress}%`);
        console.log(`💾 已下载: ${FormatUtils.formatFileSize(status.downloaded)}`);
      }
    }
  }
}

batchDownload().catch(console.error);
```

### 3. 高级监控示例

```javascript
import { S3MultiThreadDownloader, FormatUtils } from './s3-downloader.js';
import path from 'path';

async function advancedDownload() {
  const downloader = new S3MultiThreadDownloader({
    bucketName: "large-files-bucket",
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    objectKey: "big-data/dataset.tar.gz",
    concurrency: 20,
    downloadDir: "./downloads",
    logFileName: "custom_download.log"
  });

  downloader.setupInterruptHandler();

  // 创建监控间隔
  let monitorInterval;

  try {
    // 启动详细监控
    monitorInterval = setInterval(() => {
      const status = downloader.getStatus();
      if (status) {
        console.log('\n=== 详细进度报告 ===');
        console.log(`总体进度: ${status.progress}%`);
        console.log(`下载速度: ${FormatUtils.formatSpeed(status.speed)}`);
        console.log(`已下载: ${FormatUtils.formatFileSize(status.downloaded)}`);
        console.log(`总大小: ${FormatUtils.formatFileSize(status.totalSize)}`);
        console.log(`运行时间: ${FormatUtils.formatDuration(status.totalTime)}`);
        console.log(`重试次数: ${status.retries}`);
      
        // 显示每个线程状态
        const activeThreads = status.partStatus.filter(p => p.status.includes('downloading'));
        console.log(`活跃线程: ${activeThreads.length}/${status.partStatus.length}`);
      
        activeThreads.forEach(part => {
          console.log(`  线程 ${part.index}: ${part.progress}% 速度: ${FormatUtils.formatSpeed(part.speed)}`);
        });
      }
    }, 5000); // 每5秒显示一次详细信息

    const result = await downloader.start();
  
    console.log('\n🎉 下载成功完成!');
    console.log(`文件路径: ${result.filePath}`);
    console.log(`文件大小: ${FormatUtils.formatFileSize(result.fileSize)}`);
    console.log(`总耗时: ${FormatUtils.formatDuration(result.totalTime)}`);
    console.log(`平均速度: ${FormatUtils.formatSpeed(result.avgSpeed)}`);
    console.log(`总重试次数: ${result.totalRetries}`);
  
  } catch (error) {
    console.error(`下载失败: ${error.message}`);
  
    // 显示失败时的状态
    const finalStatus = downloader.getStatus();
    if (finalStatus) {
      console.log('\n📊 失败时状态:');
      console.log(`完成度: ${finalStatus.progress}%`);
      console.log(`已保存: ${FormatUtils.formatFileSize(finalStatus.downloaded)}`);
    
      finalStatus.partStatus.forEach(part => {
        if (part.progress > 0) {
          console.log(`分片 ${part.index}: ${part.progress}% (${FormatUtils.formatFileSize(part.downloaded)})`);
        }
      });
    
      console.log('\n重新运行程序可从当前进度继续下载');
    }
  } finally {
    if (monitorInterval) {
      clearInterval(monitorInterval);
    }
  }
}

advancedDownload().catch(console.error);
```

## 🔍 故障排除

### 常见问题

1. **下载速度慢**
   ```javascript
   // 方案1: 增加并发数
   concurrency: 20 // 默认 10，可根据网络情况调整
 
   // 方案2: 检查网络和 S3 端点
   endpoint: "https://your-closest-s3-endpoint.com"
 
   // 方案3: 检查带宽限制
   // 确保网络带宽充足，考虑其他网络活动
   ```

2. **频繁重试**
   ```javascript
   // 检查认证信息
   credentials: {
     accessKeyId: "确保正确的访问密钥",
     secretAccessKey: "确保正确的秘密密钥"
   }
 
   // 检查网络连接稳定性
   // 查看日志文件了解详细错误信息
   ```

3. **文件验证失败**
   ```javascript
   // 删除损坏的分片文件重新下载
   fs.unlinkSync('./downloads/filename.part0');
 
   // 检查磁盘空间是否充足
   // 确保下载目录有写入权限
   ```

4. **内存占用过高**
   ```javascript
   // 减少并发数
   concurrency: 5 // 对于大文件建议使用较少线程
 
   // 监控内存使用情况
   console.log('内存使用:', process.memoryUsage());
   ```

### 性能调优

**并发数调优**
```javascript
// 根据网络条件调整
const config = {
  // 高速网络 (100Mbps+)
  concurrency: 20,

  // 中速网络 (10-100Mbps)
  concurrency: 10,

  // 低速网络 (<10Mbps)
  concurrency: 5
};
```

**网络优化**
```javascript
// 选择最近的端点
const endpoints = {
  "us-east-1": "https://s3.us-east-1.amazonaws.com",
  "us-west-2": "https://s3.us-west-2.amazonaws.com", 
  "eu-west-1": "https://s3.eu-west-1.amazonaws.com",
  "ap-east-1": "https://s3.ap-east-1.amazonaws.com"
};
```

**磁盘 I/O 优化**
```javascript
// 使用高速磁盘作为下载目录
downloadDir: "/path/to/fast-ssd/downloads"

// 避免在系统盘下载大文件
downloadDir: "/data/downloads" // 而不是 "C:/downloads"
```

## 📊 监控和调试

### 启用详细日志

```javascript
// 在下载过程中查看实时日志
const logPath = path.join(downloader.downloadDir, 'download.log');
console.log(`实时日志: tail -f ${logPath}`);

// 或在代码中监控日志
const fs = require('fs');
const readline = require('readline');

const logStream = fs.createReadStream(logPath);
const rl = readline.createInterface({
  input: logStream,
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  if (line.includes('ERROR')) {
    console.error('发现错误:', line);
  }
});
```

### 性能指标收集

```javascript
const performanceMetrics = {
  startTime: Date.now(),
  checkpoints: [],

  addCheckpoint(name, status) {
    this.checkpoints.push({
      name,
      timestamp: Date.now(),
      elapsed: Date.now() - this.startTime,
      status: status || downloader.getStatus()
    });
  },

  generateReport() {
    console.log('\n=== 性能报告 ===');
    this.checkpoints.forEach(cp => {
      console.log(`${cp.name}: +${FormatUtils.formatDuration(cp.elapsed/1000)}`);
      if (cp.status) {
        console.log(`  进度: ${cp.status.progress}%`);
        console.log(`  速度: ${FormatUtils.formatSpeed(cp.status.speed)}`);
      }
    });
  }
};
```

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📞 支持

如有问题或建议，请：
1. 查看日志文件获取详细错误信息
2. 检查网络连接和 S3 凭证
3. 参考故障排除章节
4. 提交 GitHub Issue

---

> 💡 **提示**: 该工具支持断点续传，即使网络中断也不会丢失已下载的数据。重新启动程序即可继续下载！