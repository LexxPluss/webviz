// @flow
//
//  Copyright (c) 2019-present, Cruise LLC
//
//  This source code is licensed under the Apache License, Version 2.0,
//  found in the LICENSE file in the root directory of this source tree.
//  You may not use this file except in compliance with the License.

import { simplify } from "intervals-fn";
import { isEqual, sum, uniq } from "lodash";
import { TimeUtil, type Time } from "rosbag";
import uuid from "uuid";

import type {
  DataProvider,
  DataProviderDescriptor,
  ExtensionPoint,
  GetDataProvider,
  InitializationResult,
  DataProviderMessage,
} from "webviz-core/src/dataProviders/types";
import filterMap from "webviz-core/src/filterMap";
import { getNewConnection } from "webviz-core/src/util/getNewConnection";
import { type Range, mergeNewRangeIntoUnsortedNonOverlappingList, missingRanges } from "webviz-core/src/util/ranges";
import reportError from "webviz-core/src/util/reportError";
import { fromNanoSec, subtractTimes, toNanoSec } from "webviz-core/src/util/time";

// I (JP) mostly just made these numbers up. It might be worth experimenting with different values
// for these, but it seems to work reasonably well in my tests.
export const MEM_CACHE_BLOCK_SIZE_NS = 0.1e9; // Messages are laid out in blocks with a fixed number of milliseconds.
const READ_AHEAD_NS = 3e9; // Number of nanoseconds to read ahead from the last `getMessages` call.
const READ_AHEAD_BLOCKS = Math.ceil(READ_AHEAD_NS / MEM_CACHE_BLOCK_SIZE_NS);
const CACHE_SIZE_BYTES = 2.5e9; // Number of bytes that we aim to keep in the cache.
export const MAX_BLOCK_SIZE_BYTES = 50e6; // Number of bytes in a block before we show an error.

// For each memory block we store the actual messages (grouped by topic), and a total byte size of
// the underlying ArrayBuffers.
type MemoryCacheBlock = { messagesByTopic: { [topic: string]: DataProviderMessage[] }, sizeInBytes: number };

function getNormalizedTopics(topics: string[]): string[] {
  return uniq(topics).sort();
}

// Get the blocks to keep for the current cache purge, given the most recently accessed ranges, the
// blocks byte sizes, the minimum number of blocks to always keep, and the maximum cache size.
//
// Exported for tests.
export function getBlocksToKeep({
  recentBlockRanges,
  blockSizesInBytes,
  maxCacheSizeInBytes,
}: {|
  // The most recently requested block ranges, ordered from most recent to least recent.
  recentBlockRanges: Range[],
  // For each block, its size, if it exists. Note that it's allowed for a `recentBlockRange` to
  // not have all blocks actually available (i.e. a seek happened before the whole range was
  // downloaded).
  blockSizesInBytes: (?number)[],
  // The maximum cache size in bytes.
  maxCacheSizeInBytes: number,
|}): { blockIndexesToKeep: Set<number>, newRecentRanges: Range[] } {
  let cacheSizeInBytes = 0;
  const blockIndexesToKeep = new Set<number>();
  // Go through all the ranges, from most to least recent.
  for (let blockRangeIndex = 0; blockRangeIndex < recentBlockRanges.length; blockRangeIndex++) {
    const blockRange = recentBlockRanges[blockRangeIndex];

    // Work backwards from the end of the range, since those blocks are most relevant to keep.
    for (let blockIndex = blockRange.end - 1; blockIndex >= blockRange.start; blockIndex--) {
      // If we don't have size, there are no blocks to keep!
      const sizeInBytes = blockSizesInBytes[blockIndex];
      if (sizeInBytes === undefined) {
        continue;
      }

      // Then always add the block. But only add to `cacheSizeInBytes` if we didn't already count it.
      if (!blockIndexesToKeep.has(blockIndex)) {
        blockIndexesToKeep.add(blockIndex);
        cacheSizeInBytes += sizeInBytes;
      }

      // Terminate if we have exceeded `maxCacheSizeInBytes`.
      if (cacheSizeInBytes > maxCacheSizeInBytes) {
        return {
          blockIndexesToKeep,
          // Adjust the oldest `newRecentRanges`.
          newRecentRanges: [...recentBlockRanges.slice(0, blockRangeIndex), { start: blockIndex, end: blockRange.end }],
        };
      }
    }
  }
  return { blockIndexesToKeep, newRecentRanges: recentBlockRanges };
}

// Get the best place to start prefetching a block, given the uncached ranges and the cursor position.
// In order of preference, we would like to prefetch:
// - The leftmost uncached block to the right of the cursor, or
// - The leftmost uncached block to the left of the cursor, if one does not exist to the right.
//
// Exported for tests.
export function getPrefetchStartPoint(uncachedRanges: Range[], cursorPosition: number): number {
  uncachedRanges.sort((a, b) => {
    if (a.start < cursorPosition !== b.start < cursorPosition) {
      // On different sides of the cursor. `a` comes first if it's to the right.
      return a.start < cursorPosition ? 1 : -1;
    }
    return a.start - b.start;
  });
  return uncachedRanges[0].start;
}

// This fills up the memory with messages from an underlying DataProvider. The messages have to be
// unparsed ROS messages. The messages are evicted from this in-memory cache based on some constants
// defined at the top of this file.
export default class MemoryCacheDataProvider implements DataProvider {
  _id: string;
  _provider: DataProvider;
  _extensionPoint: ExtensionPoint;

  // The actual blocks that contain the messages. Blocks have a set "width" in terms of nanoseconds
  // since the start time of the bag. If a block has some messages for a topic, then by definition
  // it has *all* messages for that topic and timespan.
  _blocks: (?MemoryCacheBlock)[];

  // The start time of the bag. Used for computing from and to nanoseconds since the start.
  _startTime: Time;

  // The topics that we were most recently asked to load.
  // This is always set by the last `getMessages` call.
  _preloadTopics: string[] = [];

  // Total length of the data in nanoseconds. Used to compute progress with.
  _totalNs: number;

  // The current "connection", which represents the range that we're downloading.
  _currentConnection: ?{| id: string, topics: string[], remainingBlockRange: Range |};

  // The read requests we've received via `getMessages`.
  _readRequests: {|
    timeRange: Range, // Actual range of messages, in nanoseconds since `this._startTime`.
    blockRange: Range, // The range of blocks.
    topics: string[],
    resolve: (DataProviderMessage[]) => void,
  |}[] = [];

  // Recently requested ranges of blocks, sorted by most recent to least recent. There should never
  // be any overlapping ranges. Ranges *are* allowed to cover blocks that haven't been downloaded
  // (yet).
  _recentBlockRanges: Range[] = [];

  // The end time of the last callback that we've resolved. This is useful for preloading new data
  // around this time.
  _lastResolvedCallbackEnd: ?number;

  // When we log a "block too large" error, we only want to do that once, to prevent
  // spamming errors.
  _loggedTooLargeError: boolean = false;

  // If we're configured to use an unlimited cache, we try to just load as much as possible and
  // never evict anything.
  _unlimitedCache: boolean = false;

  constructor(
    { id, unlimitedCache }: {| id: string, unlimitedCache?: boolean |},
    children: DataProviderDescriptor[],
    getDataProvider: GetDataProvider
  ) {
    this._id = id;
    this._unlimitedCache = unlimitedCache || false;
    if (children.length !== 1) {
      throw new Error(`Incorrect number of children to MemoryCacheDataProvider: ${children.length}`);
    }
    this._provider = getDataProvider(children[0]);
  }

  async initialize(extensionPoint: ExtensionPoint): Promise<InitializationResult> {
    this._extensionPoint = extensionPoint;

    const result = await this._provider.initialize({ ...extensionPoint, progressCallback: () => {} });
    this._startTime = result.start;
    this._totalNs = toNanoSec(subtractTimes(result.end, result.start)) + 1; // +1 since times are inclusive.
    if (this._totalNs > Number.MAX_SAFE_INTEGER * 0.9) {
      throw new Error("Time range is too long to be supported");
    }
    this._blocks = new Array(Math.ceil(this._totalNs / MEM_CACHE_BLOCK_SIZE_NS));
    this._updateProgress();

    return result;
  }

  async getMessages(startTime: Time, endTime: Time, topics: string[]): Promise<DataProviderMessage[]> {
    // We might have a new set of topics.
    topics = getNormalizedTopics(topics);
    this._preloadTopics = topics;

    // Push a new entry to `this._readRequests`, and call `this._updateState()`.
    const timeRange = {
      start: toNanoSec(subtractTimes(startTime, this._startTime)),
      end: toNanoSec(subtractTimes(endTime, this._startTime)) + 1, // `Range` defines `end` as exclusive.
    };
    const blockRange = {
      start: Math.floor(timeRange.start / MEM_CACHE_BLOCK_SIZE_NS),
      end: Math.floor((timeRange.end - 1) / MEM_CACHE_BLOCK_SIZE_NS) + 1, // `Range` defines `end` as exclusive.
    };
    return new Promise((resolve) => {
      this._readRequests.push({ timeRange, blockRange, topics, resolve });
      this._updateState();
    });
  }

  close(): Promise<void> {
    delete this._currentConnection; // Make sure that the current "connection" loop stops executing.
    return this._provider.close();
  }

  // We're primarily interested in the topics for the first outstanding read request, and after that
  // we're interested in preloading topics (based on the *last* read request).
  _getCurrentTopics(): string[] {
    if (this._readRequests[0]) {
      return this._readRequests[0].topics;
    }
    return this._preloadTopics;
  }

  _resolveFinishedReadRequests() {
    this._readRequests = this._readRequests.filter(({ timeRange, blockRange, topics, resolve }) => {
      if (topics.length === 0) {
        resolve([]);
        return false;
      }

      // If any of the requested blocks are not fully downloaded yet, bail out.
      for (let blockIndex = blockRange.start; blockIndex < blockRange.end; blockIndex++) {
        const block = this._blocks[blockIndex];
        if (!block) {
          return true;
        }
        for (const topic of topics) {
          if (!block.messagesByTopic[topic]) {
            return true;
          }
        }
      }

      // Now that we know we have the blocks and messages, read them, and filter out just the
      // messages for the requested time range and topics.
      const messages = [];
      for (let blockIndex = blockRange.start; blockIndex < blockRange.end; blockIndex++) {
        const block = this._blocks[blockIndex];
        if (!block) {
          throw new Error("Block should have been available, but it was not");
        }
        for (const topic of topics) {
          const messagesFromBlock = block.messagesByTopic[topic];
          if (!messagesFromBlock) {
            throw new Error("Block messages should have been available, but they were not");
          }
          for (const message of messagesFromBlock) {
            const messageTime = toNanoSec(subtractTimes(message.receiveTime, this._startTime));
            if (timeRange.start /* inclusive */ <= messageTime && messageTime < timeRange.end /* exclusive */) {
              messages.push(message);
            }
          }
        }
      }
      resolve(messages.sort((a, b) => TimeUtil.compare(a.receiveTime, b.receiveTime)));
      this._lastResolvedCallbackEnd = blockRange.end;

      return false;
    });
  }

  // Gets called any time our "connection", read requests, or topics change.
  _updateState() {
    // First, see if there are any read requests that we can resolve now.
    this._resolveFinishedReadRequests();

    if (this._currentConnection && !isEqual(this._currentConnection.topics, this._getCurrentTopics())) {
      // If we have a different set of topics, stop the current "connection", and refresh everything.
      delete this._currentConnection;
    }

    // Then see if we need to set a new connection based on the new connection and read requests state.
    this._maybeRunNewConnections();
  }

  _getNewConnection() {
    const connectionForReadRange = getNewConnection({
      currentRemainingRange: this._currentConnection ? this._currentConnection.remainingBlockRange : undefined,
      readRequestRange: this._readRequests[0] ? this._readRequests[0].blockRange : undefined,
      downloadedRanges: this._getDownloadedBlockRanges(),
      lastResolvedCallbackEnd: this._lastResolvedCallbackEnd,
      cacheSize: READ_AHEAD_BLOCKS,
      fileSize: this._blocks.length,
      continueDownloadingThreshold: 10, // Somewhat arbitrary number to not create new connections all the time.
    });
    if (connectionForReadRange) {
      return connectionForReadRange;
    }
    const cacheBytesUsed = sum(filterMap(this._blocks, (block) => block && block.sizeInBytes));
    if (!this._currentConnection && cacheBytesUsed < CACHE_SIZE_BYTES) {
      // All read requests have been served, but we have free cache space available. Cache something
      // useful if possible.
      return this._getPrefetchRange();
    }
    // Either a good connection is already in progress, or we've served all connections and have
    // nothing useful to prefetch.
  }

  _getPrefetchRange() {
    const bounds = { start: 0, end: this._blocks.length };
    const uncachedRanges = missingRanges(bounds, this._getDownloadedBlockRanges());
    if (!uncachedRanges.length) {
      return; // We have loaded the whole file.
    }

    const prefetchStart = getPrefetchStartPoint(uncachedRanges, this._lastResolvedCallbackEnd || 0);
    // Just request a single block. We know there's at least one there, and we don't want to cause
    // blocks that are actually useful to be evicted because of our prefetching. We could consider
    // a "low priority" connection that aborts as soon as there's memory pressure.
    return { start: prefetchStart, end: prefetchStart + 1 };
  }

  async _maybeRunNewConnections() {
    while (true) {
      const newConnection = this._getNewConnection();
      if (!newConnection) {
        // All read requests done and nothing to prefetch, or there is a good connection already in
        // progress.
        break;
      }
      const connectionSuccess = await this._setConnection(newConnection).catch((err) => {
        reportError(
          `MemoryCacheDataProvider connection ${this._currentConnection ? this._currentConnection.id : ""}`,
          err ? err.message : "<unknown error>",
          "app"
        );
      });
      if (!connectionSuccess) {
        // Connection interrupted, or otherwise unsuccessful.
        break;
      }
      // See if there are any more read requests we should field.
    }
  }

  // Replace the current connection with a new one, spanning a certain range of blocks. Return whether we
  // completed successfully, or whether we were interrupted by another connection.
  async _setConnection(blockRange: Range): Promise<boolean> {
    if (!this._getCurrentTopics().length) {
      delete this._currentConnection;
      return true;
    }

    const id = uuid.v4();
    this._currentConnection = { id, topics: this._getCurrentTopics(), remainingBlockRange: blockRange };

    // Merge the new `blockRange` into `_recentBlockRanges`, which upholds the invariant that
    // these ranges are never overlapping.
    this._recentBlockRanges = mergeNewRangeIntoUnsortedNonOverlappingList(blockRange, this._recentBlockRanges);

    const isCurrent = () => {
      return this._currentConnection && this._currentConnection.id === id;
    };

    // Just loop infinitely, but break if the connection is not current any more.
    while (true) {
      const currentConnection = this._currentConnection;
      if (!currentConnection || !isCurrent()) {
        return false;
      }

      const currentBlockIndex = currentConnection.remainingBlockRange.start;
      // Only request topics that we don't already have.
      const topics = this._blocks[currentBlockIndex]
        ? currentConnection.topics.filter(
            (topic) => !this._blocks[currentBlockIndex] || !this._blocks[currentBlockIndex].messagesByTopic[topic]
          )
        : currentConnection.topics;

      // Get messages from the underlying provider.
      const startTime = TimeUtil.add(this._startTime, fromNanoSec(currentBlockIndex * MEM_CACHE_BLOCK_SIZE_NS));
      const endTime = TimeUtil.add(
        this._startTime,
        fromNanoSec(Math.min(this._totalNs, (currentBlockIndex + 1) * MEM_CACHE_BLOCK_SIZE_NS) - 1) // endTime is inclusive.
      );
      const messages = topics.length ? await this._provider.getMessages(startTime, endTime, topics) : [];

      // If we're not current any more, discard the messages, because otherwise we might write duplicate messages.
      if (!isCurrent()) {
        return false;
      }

      // Create a new block if necessary.
      this._blocks[currentBlockIndex] = this._blocks[currentBlockIndex] || { messagesByTopic: {}, sizeInBytes: 0 };
      const currentBlock = this._blocks[currentBlockIndex];
      if (!currentBlock) {
        throw new Error("currentBlock should be set here");
      }

      // Fill up the block with messages.
      for (const topic of topics) {
        currentBlock.messagesByTopic[topic] = [];
      }
      for (const message of messages) {
        if (!(message.message instanceof ArrayBuffer)) {
          reportError("MemoryCacheDataProvider can only be used with unparsed ROS messages", "", "app");
          // Do not retry.
          return false;
        }
        currentBlock.messagesByTopic[message.topic].push(message);
        currentBlock.sizeInBytes += message.message.byteLength;
      }

      if (currentBlock.sizeInBytes > MAX_BLOCK_SIZE_BYTES && !this._loggedTooLargeError) {
        this._loggedTooLargeError = true;
        const sizes = [];
        for (const topic of Object.keys(currentBlock.messagesByTopic)) {
          let size = 0;
          for (const message of currentBlock.messagesByTopic[topic]) {
            size += message.message.byteLength;
          }
          const roundedSize = Math.round(size / 1e6);
          if (roundedSize > 0) {
            sizes.push(`- ${topic}: ${roundedSize}MB`);
          }
        }
        reportError(
          "Very large block found",
          `A very large block (${Math.round(MEM_CACHE_BLOCK_SIZE_NS / 1e6)}ms) was found: ${Math.round(
            currentBlock.sizeInBytes / 1e6
          )}MB. Too much data can cause performance problems and even crashes. Please fix this where the data is being generated.\n\nBreakdown of large topics:\n${sizes
            .sort()
            .join("\n")}`,
          "user"
        );
      }

      // Now `this._recentBlockRanges` and `this._blocks` have been updated, so we can resolve
      // requests, purge the cache and report progress.
      this._resolveFinishedReadRequests();
      this._purgeOldBlocks();
      this._updateProgress();

      // Check *again* if we're not current any more, because now we're going to update connection
      // information.
      if (!isCurrent()) {
        return false;
      }

      if (currentBlockIndex >= blockRange.end - 1) {
        // If we're at the end of the range, we're done.
        break;
      }
      // Otherwise, update the `remainingBlockRange`.
      this._currentConnection = {
        ...this._currentConnection,
        remainingBlockRange: { start: currentBlockIndex + 1, end: blockRange.end },
      };
    }
    // Connection successfully completed.
    delete this._currentConnection;
    return true;
  }

  // For the relevant downloaded ranges, we look at `this._blocks` and the most relevant topics.
  _getDownloadedBlockRanges(): Range[] {
    const topics: string[] = this._getCurrentTopics();
    return simplify(
      filterMap(this._blocks, (block, blockIndex) => {
        if (!block) {
          return;
        }
        for (const topic of topics) {
          if (!block.messagesByTopic[topic]) {
            return;
          }
        }
        return { start: blockIndex, end: blockIndex + 1 };
      })
    );
  }

  _purgeOldBlocks() {
    if (this._unlimitedCache) {
      return;
    }

    // Call the getBlocksToKeep helper.
    const { blockIndexesToKeep, newRecentRanges } = getBlocksToKeep({
      recentBlockRanges: this._recentBlockRanges,
      blockSizesInBytes: this._blocks.map((block) => (block ? block.sizeInBytes : undefined)),
      maxCacheSizeInBytes: CACHE_SIZE_BYTES,
    });

    // Update our state.
    this._recentBlockRanges = newRecentRanges;
    for (let blockIndex = 0; blockIndex < this._blocks.length; blockIndex++) {
      if (this._blocks[blockIndex] && !blockIndexesToKeep.has(blockIndex)) {
        this._blocks[blockIndex] = undefined;
      }
    }
  }

  _updateProgress() {
    this._extensionPoint.progressCallback({
      fullyLoadedFractionRanges: this._getDownloadedBlockRanges().map((range) => ({
        // Convert block ranges into fractions.
        start: range.start / this._blocks.length,
        end: range.end / this._blocks.length,
      })),
    });
  }
}
