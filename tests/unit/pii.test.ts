import { describe, expect, it } from "vitest";
import { keyKind, maskText, nameKind } from "../../packages/core/src/pii.ts";

const masked = (text: string) => maskText(text, new Set());

describe("which column names say personal data", () => {
  it.each([
    ["email", "email"], ["EmailAddress", "email"], ["emailaddress", "email"], ["e_mail", "email"],
    ["phonenumber", "phone"], ["mobilePhone", "phone"], ["telno", "phone"],
    ["owner_name", "name"], ["author_name", "name"], ["name_first", "name"], ["surname", "name"],
    ["dateofbirth", "birth"], ["postalcode", "address"], ["streetaddress", "address"],
    ["cardnumber", "id_number"], ["card_no", "id_number"], ["my_number", "id_number"], ["SSNNumber", "id_number"],
    ["氏名", "name"], ["住所", "address"], ["電話番号", "phone"], ["メールアドレス", "email"], ["生年月日", "birth"],
  ])("%s is %s", (column, kind) => expect(nameKind(column)).toBe(kind));

  it.each([
    "name", "product_name", "file_name", "female", "hotel", "is_mobile", "mobile_app_version", "has_phone", "phone_count",
    "mail_count", "email_verified", "birth_rate", "zip_file", "mac_address", "contract_address", "address_id",
  ])("%s is not", (column) => expect(nameKind(column)).toBeUndefined());
});

describe("which text is shaped like personal data", () => {
  it.each([
    ["mail a.b@example.org.", "mail «masked:email»."],
    ["山田@example.jp", "«masked:email»"],
    ["alice@例え.jp", "«masked:email»"],
    ["alice＠example.com", "«masked:email»"],
    ["call 03-1234-5678", "call «masked:phone»"],
    ["09012345678", "«masked:phone»"],
    ["+819012345678", "«masked:phone»"],
    ["+81 90-1234-5678", "«masked:phone»"],
    ["(555) 123-4567", "«masked:phone»"],
    ["555.123.4567", "«masked:phone»"],
    ["０９０－１２３４－５６７８", "«masked:phone»"],
    ["paid with 4111 1111 1111 1111", "paid with «masked:card»"],
    ["4111111111111111", "«masked:card»"],
  ])("%s", (text, expected) => expect(masked(text)).toBe(expected));

  it.each([
    "35.6812 139.7671", "12.3456 78.9012", "1000 2000 3000", "SKU-123-456-7890", "ID 123 4567 8901", "2026 1022 1234",
    "12:34:56 1234 5678", "2026-10-22 14:00:00", "2026-10-22T14:00:00Z", "192.168.100.200", "1.2.3", "P1Y2M3DT4H",
    "1729555200008", "1234567890123456789", "icon@2x.png", "foo@3x.webp", "22.10.2026 1234", "note 1", "東京都千代田区",
  ])("%s stays", (text) => expect(masked(text)).toBe(text));

  it("collects the kinds it found", () => {
    const found = new Set<string>();
    maskText("a@b.co and 03-1234-5678", found);
    expect([...found].sort()).toEqual(["email", "phone"]);
  });
});

describe("keyKind", () => {
  it("finds a key named like personal data in each way a nested value is written", () => {
    expect(keyKind("{full name=Taro}", "MAP(VARCHAR, VARCHAR)")).toBe("name");
    expect(keyKind("{'first_name': Taro}", "STRUCT(first_name VARCHAR)")).toBe("name");
    expect(keyKind('{"email":"x"}', "JSON")).toBe("email");
    expect(keyKind("{'plan': pro}", "STRUCT(plan VARCHAR)")).toBeUndefined();
    expect(keyKind("{a, email: x}", "VARCHAR")).toBeUndefined();
  });

  it("reads a long value in one pass", () => {
    const started = Date.now();
    for (const text of ["{" + " ".repeat(1_000_000) + "x", "{" + "a,".repeat(500_000), "{" + "a:".repeat(500_000)]) {
      expect(keyKind(text, "MAP(VARCHAR, VARCHAR)")).toBeUndefined();
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
