import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * 配置验证器
 */
export class ConfigValidator {
  /**
   * 验证环境变量配置
   * @param {object} config - 配置对象
   * @returns {object} - 验证结果
   */
  static validateEnvironmentConfig(config = process.env) {
    const errors = [];
    const warnings = [];
    
    // 必需的配置项
    const requiredFields = {
      'GITHUB_TOKEN': 'GitHub 访问令牌',
      'GITHUB_USERNAME': 'GitHub 用户名'
    };
    
    // 可选但推荐的配置项
    const recommendedFields = {
      'GITHUB_REPO': 'GitHub 仓库名',
      'WATCH_PATH': '监控路径',
      'LOG_LEVEL': '日志级别'
    };
    
    // 检查必需字段
    for (const [field, description] of Object.entries(requiredFields)) {
      const value = config[field];
      if (!value || value.includes('default_') || value.includes('please_change')) {
        errors.push(`${description} (${field}) 未正确配置`);
      }
    }
    
    // 检查推荐字段
    for (const [field, description] of Object.entries(recommendedFields)) {
      const value = config[field];
      if (!value) {
        warnings.push(`建议配置 ${description} (${field})`);
      }
    }
    
    // 验证特定字段格式
    if (config.GITHUB_TOKEN && config.GITHUB_TOKEN.length < 20) {
      errors.push('GitHub Token 格式可能不正确（长度过短）');
    }
    
    if (config.WATCH_PATH && !fs.existsSync(config.WATCH_PATH)) {
      warnings.push(`监控路径不存在: ${config.WATCH_PATH}`);
    }
    
    if (config.DEBOUNCE_TIME && isNaN(parseInt(config.DEBOUNCE_TIME))) {
      errors.push('防抖时间必须是数字');
    }
    
    const validLogLevels = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'];
    if (config.LOG_LEVEL && !validLogLevels.includes(config.LOG_LEVEL)) {
      warnings.push(`日志级别应为: ${validLogLevels.join(', ')}`);
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      hasWarnings: warnings.length > 0
    };
  }
  
  /**
   * 验证项目配置
   * @param {object} project - 项目配置对象
   * @returns {object} - 验证结果
   */
  static validateProjectConfig(project) {
    const errors = [];
    const warnings = [];
    
    // 必需字段
    if (!project.name || project.name.trim() === '') {
      errors.push('项目名称不能为空');
    }
    
    if (!project.path || project.path.trim() === '') {
      errors.push('监控路径不能为空');
    } else if (!fs.existsSync(project.path)) {
      errors.push(`监控路径不存在: ${project.path}`);
    }
    
    if (!project.repo || project.repo.trim() === '') {
      errors.push('GitHub 仓库名不能为空');
    }
    
    if (!project.branch || project.branch.trim() === '') {
      warnings.push('未指定分支，将使用默认分支 main');
    }
    
    // 验证忽略模式
    if (project.ignoredPatterns) {
      const patterns = project.ignoredPatterns.split(',');
      if (patterns.some(p => p.trim() === '')) {
        warnings.push('忽略模式中包含空值');
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      hasWarnings: warnings.length > 0
    };
  }
  
  /**
   * 生成配置报告
   * @param {object} config - 配置对象
   * @returns {string} - 配置报告
   */
  static generateConfigReport(config = process.env) {
    const validation = this.validateEnvironmentConfig(config);
    
    let report = '=== 配置验证报告 ===\n';
    report += `验证时间: ${new Date().toLocaleString()}\n\n`;
    
    if (validation.isValid) {
      report += '✅ 配置验证通过\n';
    } else {
      report += '❌ 配置验证失败\n';
      report += '\n错误:\n';
      validation.errors.forEach(error => {
        report += `  - ${error}\n`;
      });
    }
    
    if (validation.hasWarnings) {
      report += '\n警告:\n';
      validation.warnings.forEach(warning => {
        report += `  - ${warning}\n`;
      });
    }
    
    report += '\n当前配置:\n';
    const configKeys = [
      'GITHUB_USERNAME', 'GITHUB_REPO', 'GITHUB_BRANCH',
      'WATCH_PATH', 'LOG_LEVEL', 'DEBOUNCE_TIME'
    ];
    
    configKeys.forEach(key => {
      const value = config[key] || '未设置';
      const maskedValue = key === 'GITHUB_TOKEN' && value !== '未设置' 
        ? `${value.substring(0, 4)}****` 
        : value;
      report += `  ${key}: ${maskedValue}\n`;
    });
    
    return report;
  }
  
  /**
   * 记录配置验证结果
   * @param {object} config - 配置对象
   */
  static logValidationResult(config = process.env) {
    const validation = this.validateEnvironmentConfig(config);
    
    if (validation.isValid) {
      logger.info('✅ 配置验证通过');
    } else {
      logger.error('❌ 配置验证失败');
      validation.errors.forEach(error => {
        logger.error(`配置错误: ${error}`);
      });
    }
    
    if (validation.hasWarnings) {
      validation.warnings.forEach(warning => {
        logger.warn(`配置警告: ${warning}`);
      });
    }
    
    return validation;
  }
}
