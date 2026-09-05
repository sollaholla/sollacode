/** Small WebGL renderer for the author's faceted solid. Draws only when its pose changes. */
export interface BoltMesh {
  positions: number[];
  normals: number[];
  colors: number[];
}
export function createBoltRenderer(canvas: HTMLCanvasElement, mesh: BoltMesh) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
  });
  if (!gl) throw new Error("WebGL unavailable");
  const shaders: WebGLShader[] = [];
  const buffers: WebGLBuffer[] = [];
  function shader(type: number, source: string) {
    const shader = gl!.createShader(type);
    if (!shader) throw new Error("Unable to allocate shader");
    shaders.push(shader);
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS))
      throw new Error("Unable to compile bolt shader");
    return shader;
  }
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to allocate program");
  gl.attachShader(
    program,
    shader(
      gl.VERTEX_SHADER,
      `
    attribute vec3 position; attribute vec3 normal; attribute vec3 color;
    uniform vec2 angles; uniform float aspect;
    varying vec3 n; varying vec3 c; varying vec3 p;
    void main(){
      float x=angles.x, y=angles.y;
      mat3 ry=mat3(cos(y),0.,-sin(y),0.,1.,0.,sin(y),0.,cos(y));
      mat3 rx=mat3(1.,0.,0.,0.,cos(x),sin(x),0.,-sin(x),cos(x));
      mat3 rotation=rx*ry;
      p=rotation*position; n=rotation*normal; c=color;
      float perspective=1.0/(1.0-p.z*.35);
      gl_Position=vec4(p.x*2.15/aspect*perspective,p.y*2.15*perspective,-p.z,1.);
    }`,
    ),
  );
  gl.attachShader(
    program,
    shader(
      gl.FRAGMENT_SHADER,
      `
    precision highp float; varying vec3 n; varying vec3 c; varying vec3 p;
    const float PI=3.14159265;
    float hash(vec3 v){return fract(sin(dot(v,vec3(127.1,311.7,74.7)))*43758.5453);}
    vec3 fresnel(float cosine, vec3 f0){return f0+(1.-f0)*pow(1.-cosine,5.);}
    vec3 light(vec3 N,vec3 V,vec3 L,vec3 radiance,vec3 f0,float rough){
      vec3 H=normalize(V+L);float nv=max(dot(N,V),.001),nl=max(dot(N,L),.001),nh=max(dot(N,H),0.),vh=max(dot(V,H),0.);
      float a=rough*rough,a2=a*a,denom=nh*nh*(a2-1.)+1.;float D=a2/(PI*denom*denom);
      float k=(rough+1.)*(rough+1.)/8.;float G=(nv/(nv*(1.-k)+k))*(nl/(nl*(1.-k)+k));
      return D*G*fresnel(vh,f0)*radiance*nl/(4.*nv*nl+.001);
    }
    vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
    void main(){
      vec3 N=normalize(n);vec3 V=normalize(vec3(0.,0.,3.)-p);
      float grain=hash(floor(p*1900.))-.5;
      N=normalize(N+vec3(grain*.005,grain*.003,0.));
      vec3 f0=mix(vec3(.95,.71,.29),max(c,vec3(.02)),.16);
      float rough=.18+grain*.025;
      vec3 R=reflect(-V,N);
      float tallbox=pow(max(0.,1.-abs(R.x+.38)/.31),5.)*smoothstep(-.9,-.4,R.y);
      float strip=pow(max(0.,1.-abs(R.x-.63)/.09),4.)*smoothstep(-.8,-.3,R.y);
      float edgebox=pow(max(0.,1.-abs(R.y-.72)/.075),3.);
      vec3 environment=vec3(.11,.12,.15)+vec3(1.,.96,.85)*tallbox*1.7+vec3(1.,.98,.93)*strip*2.8+vec3(1.)*edgebox*2.;
      vec3 color=environment*fresnel(max(dot(N,V),0.),f0);
      color+=light(N,V,normalize(vec3(-.65,.8,1.5)),vec3(6.,5.8,5.2),f0,rough);
      color+=light(N,V,normalize(vec3(.9,-.3,.75)),vec3(3.,3.,2.8),f0,rough);
      color+=light(N,V,normalize(vec3(-.15,-1.,.4)),vec3(1.4,1.6,2.),f0,.24);
      color+=pow(max(c,vec3(.01)),vec3(.7))*(.2+.36*max(dot(N,normalize(vec3(-.5,.9,1.))),0.));
      gl_FragColor=vec4(pow(aces(color),vec3(1./2.2)),1.);
    }`,
    ),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error("Unable to link bolt program");
  gl.useProgram(program);
  for (const [name, data] of [
    ["position", mesh.positions],
    ["normal", mesh.normals],
    ["color", mesh.colors],
  ] as const) {
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("Unable to allocate geometry");
    buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
  }
  const angles = gl.getUniformLocation(program, "angles");
  const aspect = gl.getUniformLocation(program, "aspect");
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);
  return {
    draw(
      x: number,
      y: number,
      width = canvas.clientWidth,
      height = canvas.clientHeight,
      pixelRatio = Math.min(window.devicePixelRatio, 2),
    ) {
      const w = Math.max(1, Math.round(width * pixelRatio)),
        h = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.useProgram(program);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform2f(angles, x, y);
      gl.uniform1f(aspect, w / h);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.positions.length / 3);
    },
    dispose() {
      for (const buffer of buffers) gl.deleteBuffer(buffer);
      for (const shader of shaders) gl.deleteShader(shader);
      gl.deleteProgram(program);
    },
  };
}
