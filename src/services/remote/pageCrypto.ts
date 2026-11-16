/**
 * SHA-256 and HMAC-SHA256 for the phone page, as plain ES5 source.
 *
 * A remembered phone proves itself by answering the server's challenge with
 * HMAC-SHA256(device key, PROOF_CONTEXT + nonce). The page runs on
 * http://<lan-ip>, which is not a secure context, so browsers leave
 * crypto.subtle undefined there; the hash has to ship with the page.
 *
 * It lives in its own module so a test can run this exact source against
 * node:crypto. Keep it ES5 with no template literals or backslashes: it is
 * pasted verbatim into the page script inside webui.ts.
 */

/** Domain separation, so the key cannot be reused to sign anything else. */
export const PROOF_CONTEXT = 'tau-remote-auth|'

export const PAGE_CRYPTO_JS = `
  var SHA256_K=[
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];

  function sha256(bytes){
    var n=bytes.length, blocks=((n+8)>>6)+1, end=blocks*64, buf=new Uint8Array(end), w=new Array(64);
    var h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
        h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
    var i,j,o,x,y,a,b,c,d,e,f,g,h,t1,t2,hi=Math.floor(n/0x20000000),lo=(n*8)>>>0;
    buf.set(bytes);
    buf[n]=0x80;
    buf[end-8]=hi>>>24; buf[end-7]=(hi>>>16)&255; buf[end-6]=(hi>>>8)&255; buf[end-5]=hi&255;
    buf[end-4]=lo>>>24; buf[end-3]=(lo>>>16)&255; buf[end-2]=(lo>>>8)&255; buf[end-1]=lo&255;
    for(o=0;o<end;o+=64){
      for(i=0;i<16;i++){
        j=o+i*4;
        w[i]=(buf[j]<<24)|(buf[j+1]<<16)|(buf[j+2]<<8)|buf[j+3];
      }
      for(i=16;i<64;i++){
        x=w[i-15]; y=w[i-2];
        w[i]=(((x>>>7)|(x<<25))^((x>>>18)|(x<<14))^(x>>>3))+
             (((y>>>17)|(y<<15))^((y>>>19)|(y<<13))^(y>>>10))+w[i-16]+w[i-7]|0;
      }
      a=h0;b=h1;c=h2;d=h3;e=h4;f=h5;g=h6;h=h7;
      for(i=0;i<64;i++){
        t1=h+(((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7)))+((e&f)^(~e&g))+SHA256_K[i]+w[i]|0;
        t2=(((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10)))+((a&b)^(a&c)^(b&c))|0;
        h=g;g=f;f=e;e=d+t1|0;d=c;c=b;b=a;a=t1+t2|0;
      }
      h0=h0+a|0;h1=h1+b|0;h2=h2+c|0;h3=h3+d|0;h4=h4+e|0;h5=h5+f|0;h6=h6+g|0;h7=h7+h|0;
    }
    var out=new Uint8Array(32), hs=[h0,h1,h2,h3,h4,h5,h6,h7];
    for(i=0;i<8;i++){
      out[i*4]=hs[i]>>>24; out[i*4+1]=(hs[i]>>>16)&255; out[i*4+2]=(hs[i]>>>8)&255; out[i*4+3]=hs[i]&255;
    }
    return out;
  }

  function hmacSha256(key,msg){
    if(key.length>64) key=sha256(key);
    var inner=new Uint8Array(64+msg.length), outer=new Uint8Array(96), i, k;
    for(i=0;i<64;i++){
      k=i<key.length?key[i]:0;
      inner[i]=k^0x36; outer[i]=k^0x5c;
    }
    inner.set(msg,64);
    outer.set(sha256(inner),64);
    return sha256(outer);
  }

  function toHex(bytes){
    var s='',i;
    for(i=0;i<bytes.length;i++) s+=(bytes[i]<16?'0':'')+bytes[i].toString(16);
    return s;
  }
  function fromHex(hex){
    var out=new Uint8Array(hex.length>>1),i;
    for(i=0;i<out.length;i++) out[i]=parseInt(hex.substr(i*2,2),16);
    return out;
  }
  function asciiBytes(s){
    var out=new Uint8Array(s.length),i;
    for(i=0;i<s.length;i++) out[i]=s.charCodeAt(i)&255;
    return out;
  }
  function deviceProof(keyHex,nonce){
    return toHex(hmacSha256(fromHex(keyHex), asciiBytes('${PROOF_CONTEXT}'+nonce)));
  }
`
