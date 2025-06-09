import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 创建日志目录
const logsDir = path.join(path.dirname(__dirname), 'logs');

// 确保日志目录存在
try {
  fs.mkdir(logsDir, { recursive: true });
} catch (error) {
  console.error(`无法创建日志目录: ${error.message}`);
}

// 创建自定义过滤器，忽略系统文件访问警告
const systemFilesFilter = winston.format((info) => {
  // 如果是警告级别且包含系统文件的访问错误，则忽略
  if (info.level === 'warn' && 
      (info.message.includes('hiberfil.sys') ||
       info.message.includes('pagefile.sys') ||
       info.message.includes('swapfile.sys') ||
       info.message.includes('System Volume Information') ||
       info.message.includes('$Recycle.Bin'))) {
    return false; // 不记录此日志
  }
  return info;
});

// 配置日志格式
const logFormat = winston.format.combine(
  systemFilesFilter(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ level, message, timestamp }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
  })
);

// 创建 logger 实例
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    // 控制台输出
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      )
    }),
    
    // 文件输出
    new winston.transports.File({ 
      filename: 'error.log',
      dirname: logsDir,
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    // 所有日志
    new winston.transports.File({ 
      filename: 'combined.log',
      dirname: logsDir,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
}); 