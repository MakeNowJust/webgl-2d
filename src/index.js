import 'babel-polyfill';

import vec2 from 'gl-vec2';
import mat3 from 'gl-mat3';

// Constants
const VERTEX_SIZE = 2;
const COLOR_SIZE = 4;
const REGION_SIZE = 2;
const TEXTURE_SIZE = 1;

const ELEMENT_SIZE = VERTEX_SIZE + COLOR_SIZE + REGION_SIZE + TEXTURE_SIZE;
const ELEMENT_OFFSET = ELEMENT_SIZE * Float32Array.BYTES_PER_ELEMENT;

const VERTEX_ELEMENT = 0;
const COLOR_ELEMENT = VERTEX_ELEMENT + VERTEX_SIZE;
const REGION_ELEMENT = COLOR_ELEMENT + COLOR_SIZE;
const TEXTURE_ELEMENT = REGION_ELEMENT + REGION_SIZE;

const VERTEX_OFFSET = VERTEX_ELEMENT * Float32Array.BYTES_PER_ELEMENT;
const COLOR_OFFSET = COLOR_ELEMENT * Float32Array.BYTES_PER_ELEMENT;
const REGION_OFFSET = REGION_ELEMENT * Float32Array.BYTES_PER_ELEMENT;
const TEXTURE_OFFSET = TEXTURE_ELEMENT * Float32Array.BYTES_PER_ELEMENT;

const ELEMENTS_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;

const MAX_LENGTH = 16000;

class Shader {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {number} maxTextures
   * @param {string} precision
   */
  constructor(gl, maxTextures, precision) {
    this.gl = gl;

    this.vertex = this.createShader(
      gl.VERTEX_SHADER,
      `
        precision highp float;

        attribute vec2 aVertex;
        attribute vec4 aColor;
        attribute vec2 aRegion;
        attribute float aTexture;

        uniform mat3 uMatrix;

        varying vec4 vColor;
        varying vec2 vRegion;
        varying float vTexture;

        void main(void) {
          gl_Position = vec4((uMatrix * vec3(aVertex, 1)).xy, 0, 1);

          vColor = vec4(aColor.rgb * aColor.a, aColor.a);
          vRegion = aRegion;
          vTexture = aTexture;
        }
      `,
    );

    const textureSelector = [];
    textureSelector.push(`if (texture == 0) gl_FragColor = texture2D(uSampler[0], vRegion) * vColor;`);
    for (let i = 1; i < maxTextures - 1; i++) {
      textureSelector.push(`else if (texture == ${i}) gl_FragColor = texture2D(uSampler[${i}], vRegion) * vColor;`)
    }
    textureSelector.push(`else gl_FragColor = texture2D(uSampler[${maxTextures - 1}], vRegion) * vColor;`)

    this.fragment = this.createShader(
      gl.FRAGMENT_SHADER,
      `
        precision ${precision} float;

        uniform sampler2D uSampler[${maxTextures}];

        varying vec4 vColor;
        varying vec2 vRegion;
        varying float vTexture;

        void main(void) {
          int texture = int(vTexture);

          ${textureSelector.join(`
          `)}
        }
      `,
    );

    this.program = this.createProgram(this.vertex, this.fragment);

    this.attributes = {
      vertex: this.getAttribute('aVertex'),
      color: this.getAttribute('aColor'),
      region: this.getAttribute('aRegion'),
      texture: this.getAttribute('aTexture'),
    };

    this.uniforms = {
      matrix: gl.getUniformLocation(this.program, 'uMatrix'),
      sampler: gl.getUniformLocation(this.program, 'uSampler'),
    };
  }

  /**
   * @private
   * @param {number} type
   * @param {string} source
   * @returns {WebGLShader}
   */
  createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      throw new Error(`QuadShader.creareShader: failed on shader compilation:\n${log}`);
    }

    return shader;
  }

  /**
   * @private
   * @param {WebGLShader} vertex
   * @param {WebGLShader} fragment
   */
  createProgram(vertex, fragment) {
    const gl = this.gl;
    const program = gl.createProgram();

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.validateProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      throw new Error(`QuadShader.createProgram: failed on program linking:\n${log}`);
    }

    return program;
  }

  /**
   * @param {string} name
   */
  getAttribute(name) {
    const gl = this.gl;
    const location = gl.getAttribLocation(this.program, name)
    gl.enableVertexAttribArray(location);
    return location;
  }
}

class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    const gl = canvas.getContext('webgl');

    this.length = 0;

    this.canvas = canvas;
    this.gl = gl;

    const maxTextures = Math.min(24, gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS));
    const {precision: precisionSize} = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const precision = precisionSize < 16 ? 'mediump' : 'highp';

    this.maxTextures = maxTextures;
    this.precision = precision;

    this.shader = new Shader(gl, maxTextures, precision);
    gl.useProgram(this.shader.program);

    // Stream buffer
    this.sb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sb);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      MAX_LENGTH * ELEMENT_OFFSET * ELEMENTS_PER_QUAD,
      gl.STREAM_DRAW,
    );

    this.sbSize = 256;
    this.sbOffset = 0;

    this.stream = new Float32Array(this.sbSize * ELEMENT_SIZE * ELEMENTS_PER_QUAD);

    // Index buffer
    this.ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.createIB(), gl.STATIC_DRAW);

    // Bind attribute pointers
    gl.vertexAttribPointer(
      this.shader.attributes.vertex,
      VERTEX_SIZE,
      gl.FLOAT,
      false,
      ELEMENT_OFFSET,
      VERTEX_OFFSET
    );
    gl.vertexAttribPointer(
      this.shader.attributes.color,
      COLOR_SIZE,
      gl.FLOAT,
      false,
      ELEMENT_OFFSET,
      COLOR_OFFSET
    );
    gl.vertexAttribPointer(
      this.shader.attributes.region,
      REGION_SIZE,
      gl.FLOAT,
      false,
      ELEMENT_OFFSET,
      REGION_OFFSET
    );
    gl.vertexAttribPointer(
      this.shader.attributes.texture,
      TEXTURE_SIZE,
      gl.FLOAT,
      false,
      ELEMENT_OFFSET,
      TEXTURE_OFFSET,
    );

    this.emptyTexture = gl.createTexture();
    const buffer = new Uint8Array([255, 0, 0, 255]); // WARNING RED!
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buffer);

    this.reset();
    this.setProjection(canvas.width, canvas.height);

    this.nextUnit = 0;
    this.cache = new Map();

    this.color = [1, 1, 1, 1];

    // Pre-allocated vectors
    this.vectors = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];

    // Pre-allocated matrix
    this.matrix = [
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ];

    // Initialize claer color and alpha blend function
    this.setClearColor(0, 0, 0, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  }

  setClearColor(r, g, b, a) {
    this.gl.clearColor(r, g, b, a);
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  setProjection(width, height) {
    const gl = this.gl;

    this.flush();

    this.uMatrix = [
      2 / width, 0, 0,
      0, -2 / height, 0,
      -1, 1, 1,
    ];

    gl.viewport(0, 0, width, height);
    gl.uniformMatrix3fv(
      this.shader.uniforms.matrix,
      false,
      this.uMatrix,
    );
  }

  uploadImage(image) {
    if (this.cache.has(image)) {
      return this.cache.get(image);
    }

    const gl = this.gl;
    const texture = gl.createTexture();

    const unit = this.nextUnit;
    this.nextUnit += 1;

    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.cache.set(image, unit);

    return unit;
  }

  reset() {
    const gl = this.gl;

    this.sbOffset = 0;
    this.length = 0;

    const sampler = new Array(this.maxTextures);
    for (let i = 0; i < this.maxTextures; i++) {
      sampler[i] = i;
    }

    gl.uniform1iv(this.shader.uniforms.sampler, sampler);

    for (let i = 0; i < this.maxTextures; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture);
    }
  }

  clear() {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  flush() {
    if (this.length > 0) {
      const gl = this.gl;

      const length = this.length * ELEMENT_SIZE * ELEMENTS_PER_QUAD;
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.stream.subarray(0, length),
      );

      gl.drawElements(
        gl.TRIANGLES,
        this.length * INDICES_PER_QUAD,
        gl.UNSIGNED_SHORT,
        0,
      );

      this.sbOffset = 0;
      this.length = 0;
    }
  }

  /**
   * @param {HTMLImageElement} image
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number} regionX
   * @param {number} regionY
   * @param {number} regionWidth
   * @param {number} regionHeight
   * @param {number} rotateAngle
   * @param {number} rotateOriginX
   * @param {number} rotateOriginY
   */
  drawImage(image, x, y, width, height, regionX, regionY, regionWidth, regionHeight, rotateAngle = 0, rotateOriginX = 0, rotateOriginY = 0) {
    if (this.color[3] <  1 / 256) {
      return;
    }

    if (this.length >= MAX_LENGTH) {
      this.flush();
    }
    if (this.length >= this.sbSize) {
      this.resizeSB();
    }

    const idx0 = this.sbOffset;
    const idx1 = idx0 + ELEMENT_SIZE;
    const idx2 = idx1 + ELEMENT_SIZE;
    const idx3 = idx2 + ELEMENT_SIZE;

    const v0 = this.vectors[0];
    v0[0] = x; v0[1] = y;
    const v1 = this.vectors[1];
    v1[0] = x + width; v1[1] = y;
    const v2 = this.vectors[2];
    v2[0] = x; v2[1] = y + height;
    const v3 = this.vectors[3];
    v3[0] = x + width; v3[1] = y + height;

    if (rotateAngle !== 0) {
      const translate = this.vectors[4];
      mat3.identity(this.matrix);
      translate[0] = x + rotateOriginX; translate[1] = y + rotateOriginY;
      mat3.translate(this.matrix, this.matrix, translate);
      mat3.rotate(this.matrix, this.matrix, rotateAngle);
      translate[0] *= -1; translate[1] *= -1;
      mat3.translate(this.matrix, this.matrix, translate);
      vec2.transformMat3(v0, v0, this.matrix);
      vec2.transformMat3(v1, v1, this.matrix);
      vec2.transformMat3(v2, v2, this.matrix);
      vec2.transformMat3(v3, v3, this.matrix);
    }

    const color = this.color;

    const imageWidth = image.naturalWidth;
    const imageHeight = image.naturalHeight;
    const r0 = regionX / imageWidth;
    const r1 = regionY / imageHeight;
    const r2 = (regionX + regionWidth) / imageWidth;
    const r3 = (regionY + regionHeight) / imageHeight;

    const unit = this.uploadImage(image);

    this.stream[idx0 + VERTEX_ELEMENT + 0] = v0[0];
    this.stream[idx0 + VERTEX_ELEMENT + 1] = v0[1];
    this.stream[idx1 + VERTEX_ELEMENT + 0] = v1[0];
    this.stream[idx1 + VERTEX_ELEMENT + 1] = v1[1];
    this.stream[idx2 + VERTEX_ELEMENT + 0] = v2[0];
    this.stream[idx2 + VERTEX_ELEMENT + 1] = v2[1];
    this.stream[idx3 + VERTEX_ELEMENT + 0] = v3[0];
    this.stream[idx3 + VERTEX_ELEMENT + 1] = v3[1];

    this.stream.set(color, idx0 + COLOR_ELEMENT);
    this.stream.set(color, idx1 + COLOR_ELEMENT);
    this.stream.set(color, idx2 + COLOR_ELEMENT);
    this.stream.set(color, idx3 + COLOR_ELEMENT);

    this.stream[idx0 + REGION_ELEMENT + 0] = r0;
    this.stream[idx0 + REGION_ELEMENT + 1] = r1;
    this.stream[idx1 + REGION_ELEMENT + 0] = r2;
    this.stream[idx1 + REGION_ELEMENT + 1] = r1;
    this.stream[idx2 + REGION_ELEMENT + 0] = r0;
    this.stream[idx2 + REGION_ELEMENT + 1] = r3;
    this.stream[idx3 + REGION_ELEMENT + 0] = r2;
    this.stream[idx3 + REGION_ELEMENT + 1] = r3;

    this.stream[idx0 + TEXTURE_ELEMENT] = unit;
    this.stream[idx1 + TEXTURE_ELEMENT] = unit;
    this.stream[idx2 + TEXTURE_ELEMENT] = unit;
    this.stream[idx3 + TEXTURE_ELEMENT] = unit;

    this.sbOffset += ELEMENT_SIZE * ELEMENTS_PER_QUAD;
    this.length += 1;
  }

  /**
   * @private
   */
  createIB() {
    var indices = [
      0, 1, 2,
      2, 1, 3,
    ];

    // ~384KB index buffer
    const data = new Array(MAX_LENGTH * INDICES_PER_QUAD);
    for (var i = 0; i < data.length; i++) {
      data[i] = indices[i % INDICES_PER_QUAD] +
        ~~(i / INDICES_PER_QUAD) * ELEMENTS_PER_QUAD;
    }

    return new Uint16Array(data);
  }

  /**
   * @private
   */
  resizeSB() {
    this.sbSize <<= 1;
    const stream = new Float32Array(this.sbSize * ELEMENT_SIZE * ELEMENTS_PER_QUAD);
    stream.set(this.stream);
    this.stream = stream;
  }
}

document.querySelector('#img-box').innerHTML = ''; // reset for HMR

const canvas = document.querySelector('#app');
canvas.width = 400;
canvas.height = 300;

const renderer = new Renderer(canvas);

const loadImage = async src => new Promise((resolve, reject) => {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    document.querySelector('#img-box').appendChild(image);
    resolve(image);
  };
  image.onerror = reject;

  image.src = src;
});

const delay = async ms => new Promise(resolve => setTimeout(resolve, ms));
const nextFrame = async () => new Promise(resolve => requestAnimationFrame(resolve));

const main = async () => {
  const image = await loadImage('https://picsum.photos/100/100');
  const move = await loadImage('https://picsum.photos/50/50');
  const bg = await loadImage('https://picsum.photos/400/300');


  let i = 0;
  for (;;) {

    renderer.clear();
    renderer.drawImage(bg, 0, 0, 400, 300, 0, 0, 400, 300);
    renderer.drawImage(image, 150, 100, 100, 100, 0, 0, 100, 100, -i / 180 * Math.PI, 50, 50);
    renderer.drawImage(image, 150 + 125, 100, 100, 100, 0, 0, 100, 100);
    renderer.drawImage(image, 150 - 125, 100, 100, 100, 0, 0, 100, 100);
    renderer.drawImage(move, 175, 125, 50, 50, 0, 0, 50, 50, i / 180 * Math.PI, 25, 25);
    renderer.flush();
    renderer.gl.flush();

    i += 1;

    await nextFrame();
  }
};

main();
