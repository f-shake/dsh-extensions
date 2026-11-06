import assert from "node:assert/strict";
import { test } from "node:test";

import { attrValue, countHanzi, escapeXml, extractText, findElements, isHanzi, scanTags, unescapeXml } from "../lib/xml.js";

test("xml：标签扫描能区分开始、结束、自闭合", () => {
  const tags = scanTags('<w:p><w:r><w:t xml:space="preserve">字</w:t></w:r><w:tab/></w:p>');
  assert.deepEqual(
    tags.map((tag) => `${tag.kind}:${tag.name}`),
    ["open:w:p", "open:w:r", "open:w:t", "close:w:t", "close:w:r", "self:w:tab", "close:w:p"],
  );
});

test("xml：findElements 只返回最外层，文本框里嵌套的段落不重复算", () => {
  const xml = '<w:p id="outer"><w:r><w:txbxContent><w:p id="inner"><w:r><w:t>内</w:t></w:r></w:p></w:txbxContent></w:r></w:p><w:p id="second"/>';
  const found = findElements(xml, "w:p");
  assert.equal(found.length, 2, "外层 + 自闭合，内层不单列");
  assert.equal(found[0].selfClosing, false);
  assert.equal(found[1].selfClosing, true);
  assert.ok(xml.slice(found[0].innerStart, found[0].innerEnd).includes('id="inner"'));
});

test("xml：属性取原值，单双引号都认", () => {
  const tag = `<w:pStyle w:val="TOC1" w:other='单引号'/>`;
  assert.equal(attrValue(tag, "w:val"), "TOC1");
  assert.equal(attrValue(tag, "w:other"), "单引号");
  assert.equal(attrValue(tag, "w:missing"), null);
  // 属性名里的点不能当正则通配符。
  assert.equal(attrValue('<w:x w:a.b="1"/>', "w:aXb"), null);
});

test("xml：实体转义与反转义互逆", () => {
  const text = '他说 & <这> "句" 话';
  assert.equal(unescapeXml(escapeXml(text)), text);
  assert.equal(unescapeXml("&#20320;&#22909;"), "你好");
  assert.equal(unescapeXml("&#x4F60;&#x597D;"), "你好");
});

test("xml：extractText 拼接多个 w:t，并忽略实体", () => {
  assert.equal(extractText("<w:r><w:t>前</w:t><w:t>后</w:t></w:r>"), "前后");
  assert.equal(extractText("<w:r><w:t>a&amp;b</w:t></w:r>"), "a&b");
  assert.equal(extractText("<w:r><w:t/></w:r>"), "");
  assert.equal(extractText("<w:r><w:instrText>HYPERLINK</w:instrText></w:r>"), "");
});

test("xml：汉字计数与单字判定", () => {
  assert.equal(countHanzi("我今天去了abc 123"), 5);
  assert.equal(countHanzi("。，！？"), 0);
  assert.equal(isHanzi("字"), true);
  assert.equal(isHanzi("a"), false);
  assert.equal(isHanzi("字字"), false);
  assert.equal(isHanzi(""), false);
});
