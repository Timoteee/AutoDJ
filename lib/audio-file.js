function isAudioHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  return buf.subarray(0, 3).toString('ascii') === 'ID3'
    || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
    || ['OggS', 'fLaC', 'RIFF'].includes(buf.subarray(0, 4).toString('ascii'))
    || buf.subarray(4, 8).toString('ascii') === 'ftyp'
    || buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}
module.exports = { isAudioHeader };
