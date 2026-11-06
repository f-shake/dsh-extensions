/**
 * 最小 zip 读写，只服务 docx 这一个用途。
 *
 * 为什么不用 fflate / jszip：docx 只需要「整包解压 → 换掉一个 document.xml → 重新打包」
 * 这一条路径，Node 自带的 zlib 就够；引第三方库会让插件在 profile 里多一份运行时依赖，
 * 而 profile 的 node_modules 是 hoisted 的，靠不住。
 *
 * 写出来的 zip 不做 zip64、不带 data descriptor、统一用 deflate——Word 与 LibreOffice
 * 都吃这套最保守的格式。
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** CRC32 查表，模块加载时算一次。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * 算 CRC32。
 * @param {Buffer} buffer - 数据。
 * @returns {number} 无符号 32 位校验值。
 */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 找中央目录尾记录。注释最长 65535 字节，所以只需扫尾部。
 * @param {Buffer} buffer - 整个 zip。
 * @returns {number} EOCD 的偏移。
 */
function findEocd(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("不是有效的 zip：找不到中央目录结尾");
}

/**
 * 解一个 zip。
 *
 * 入口偏移与压缩大小都以**中央目录**为准，而不是本地头：带 data descriptor
 * 的条目在本地头里长度字段是 0，只有中央目录才写了真值。
 * @param {Buffer} buffer - zip 内容。
 * @returns {Map<string, Buffer>} 条目名到解压后的内容，保持进入顺序。
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("readZip 需要 Buffer");
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error("这个 docx 用了 zip64，暂不支持");
  }

  const entries = new Map();
  let cursor = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error("zip 中央目录损坏：签名不匹配");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`zip 条目损坏：${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip 条目 ${name} 用了不支持的压缩方法 ${method}`);
    if (data.length !== uncompressedSize) {
      throw new Error(`zip 条目 ${name} 长度不符：期望 ${uncompressedSize}，实际 ${data.length}`);
    }
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * DOS 时间戳。zip 里没有跨时区语义，用本地时间即可。
 * @param {Date} date - 时间。
 * @returns {{ time: number, date: number }} 两个字。
 */
function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

/**
 * 打一个 zip。
 * @param {Array<{ name: string, data: Buffer }>} entries - 条目，顺序即写出顺序。
 * @param {Date} [when] - 时间戳，默认当前时间（单测会传固定值）。
 * @returns {Buffer} zip 内容。
 */
export function writeZip(entries, when = new Date()) {
  const stamp = dosStamp(when);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    // 0x0800 = 文件名按 UTF-8 解释，中文路径才不会被 Word 读成乱码。
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}
