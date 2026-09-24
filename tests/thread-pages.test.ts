import { expect, test } from "bun:test";
import { bulkPageNumbers, recentPageNumbers } from "../src/thread-pages.ts";

test("recent page selection covers the end of long and short threads", () => {
  expect(recentPageNumbers(88)).toEqual([86, 87, 88]);
  expect(recentPageNumbers(2)).toEqual([1, 2]);
  expect(recentPageNumbers(1)).toEqual([1]);
  expect(recentPageNumbers(88, 0)).toEqual([]);
  expect(bulkPageNumbers(88)).toEqual([1, 86, 87, 88]);
  expect(bulkPageNumbers(2)).toEqual([1, 2]);
  expect(bulkPageNumbers(88, 0)).toEqual([1]);
  expect(bulkPageNumbers(88, 3, true, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
