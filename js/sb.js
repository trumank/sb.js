var sb = {
	extend: function (base, ex) {
		for (var key in ex) {
			if (ex.hasOwnProperty(key)) {
				base[key] = ex[key];
			}
		}
	}
};

sb.Project = function (path) {
	this._path = path;
	this.stage = null;
	this.info = null;
};

sb.extend(sb.Project.prototype, {
	open: function (onload) {
		var self = this;
		var xhr = new XMLHttpRequest();
		xhr.open('GET', this._path, true);
		xhr.responseType = 'arraybuffer';
		xhr.onload = function () {
			var stream = new sb.ByteStream(xhr.response);
			if (stream.utf8(8) === 'ScratchV') {
				if (Number(stream.utf8(2) > 0)) {
					self.read1(stream, onload);
					return;
				}
			} else {
				stream.set(0);
				if (stream.utf8(2) === 'PK') {
					stream.set(0);
					self.read2(stream, onload);
					return;
				}
			}
			onload(false);
		};
		xhr.send();
	},
	read1: function (stream, onload) {
		stream.uint32();
		var ostream = new sb.ObjectStream(stream);
		this.info = ostream.readObject();
		this.stage = ostream.readObject();
		onload(true);
	},
	read2: function (stream, onload) {
		var array = stream._uint8array;
		var string = '';
		for (var i = 0; i < array.length; i++) {
			string += String.fromCharCode(array[i]);
		}
		var zip = new JSZip(string, {base64:false});
		var images = zip.file(/[0-9]+\.png/).sort(function (a, b) {
			return parseInt(a.name, 10) - parseInt(b.name, 10);  
		}).map(function (file) {
			var image = new Image();
			image.src = 'data:image/png;base64,' + btoa(file.data);
			return image;
		});
		var fixImages = function (costumes) {
			var i = costumes.length;
			while (i--) {
				var obj = costumes[i];
				obj.image = images[obj.baseLayerID];
				delete obj.baseLayerID;
				delete obj.baseLayerMD5;
			}
		}
		var stage = JSON.parse(zip.file('project.json').data);
		fixImages(stage.costumes);
		
		var children = stage.children;
		var i = children.length;
		while (i--) {
			if (children[i].costumes) {
				fixImages(children[i].costumes);
			}
		}
		
		this.info = stage.info;
		delete stage.info;
		this.stage = stage;
		
		onload(true);
	}
});

sb.ByteStream = function (arraybuffer) {
	this.buffer = arraybuffer;
	this._index = 0;
	this._uint8array = new Uint8Array(this.buffer);
};

sb.extend(sb.ByteStream.prototype, {
	set: function (index) {
		this._index = index;
	},
	skip: function (i) {
		this._index += i;
	},
	utf8: function (length) {
		var string = '';
		for (var i = 0; i < length; i++) {
			string += String.fromCharCode(this.uint8());
		}
		return string;
	},
	arrayBuffer: function (length, reverse) {
		if (reverse) {
			var array = new Uint8Array(length);
			var i = length;
			while (i--) {
				array[i] = this.uint8();
			}
			return array.buffer;
		}
		return this.buffer.slice(this._index, this._index += length);
	},
	uint8: function () {
		return this._uint8array[this._index++];
	},
	int8: function () {
		var i = this.uint8();
		return i > 63 ? i - 0xff : i;
	},
	uint16: function () {
		return this.uint8() << 8 | this.uint8();
	},
	int16: function () {
		var i = this.uint16();
		return i > 0x7fff ? i - 0xffff : i;
	},
	uint24: function () {
		return this.uint8() << 16 | this.uint8() << 8 | this.uint8();
	},
	uint32: function () {
		return this.uint8() * 0x1000000 + (this.uint8() << 16) + (this.uint8() << 8) + this.uint8();
	},
	int32: function () {
		var i = this.uint32();
		return i > 0x7fffffff ? i - 0xffffffff : i;
	},
	float64: function () {
		return new Float64Array(this.arrayBuffer(8, true))[0];
	}
});

sb.ObjectStream = function (stream) {
	this._stream = stream;
};

sb.extend(sb.ObjectStream.prototype, {
	readObject: function () {
		if (this._stream.utf8(10) !== 'ObjS\x01Stch\x01') {
			throw new Error('Not an object');
		}
		var size = this._stream.uint32();
		
		var table = [];
		
		var i = size;
		while (i--) {
			table.push(this.readTableObject());
		}
		
		i = size;
		while (i--) {
			this.fixObjectRefs(table, table[i]);
		}
		
		return this.jsonify(this.deRef(table, table[0]));
	},
	readTableObject: function () {
		var id = this._stream.uint8();
		if (id < 99) {
			return {
				id: id,
				object: this.readFixedFormat(id)
			};
		}
		return this.readUserFormat(id);
	},
	readUserFormat: function (id) {
		var object = {
			id: id,
			version: this._stream.uint8(),
			fields: []
		};
		var i = this._stream.uint8();
		while (i--) {
			object.fields.push(this.readInline());
		}
		return object;
	},
	readFixedFormat: function (id) {
		switch (id) {
		case 9: // String
		case 10: // Symbol
		case 14: // Utf8
			return this._stream.utf8(this._stream.uint32());
		case 11: // ByteArray
			return new Uint8Array(this._stream.arrayBuffer(this._stream.uint32()));
		case 12: // SoundBuffer
			return new Uint16Array(this._stream.arrayBuffer(this._stream.uint32() * 2));
		case 13: // Bitmap
			var a = new Uint8Array(this._stream.arrayBuffer(this._stream.uint32() * 4));
			a.bitmap = true;
			return a;
		case 20: // Array
		case 21: // OrderedCollection
			var array = [];
			var i = this._stream.uint32();
			while (i--) {
				array.push(this.readInline());
			}
			return array;
		case 24: // Dictionary
		case 25: // IdentityDictionary
			var array = new sb.Dict();
			var i = this._stream.uint32();
			while (i--) {
				array[i] = [this.readInline(), this.readInline()];
			}
			return array;
		case 30: // Color
			var color = this._stream.uint32();
			return {
				r: color >> 22 & 0xff,
				g: color >> 12 & 0xff,
				b: color >> 2 & 0xff,
				a: 255
			};
		case 31: // TranslucentColor
			var color = this._stream.uint32();
			return {
				r: color >> 22 & 0xff,
				g: color >> 12 & 0xff,
				b: color >> 2 & 0xff,
				a: this._stream.uint8()
			};
		case 32: // Point
			return {
				x: this.readInline(),
				y: this.readInline()
			};
		case 33: // Rectangle
			return {
				ox: this.readInline(),
				oy: this.readInline(),
				cx: this.readInline(),
				cy: this.readInline()
			};
		case 34: // Form
			return {
				width: this.readInline(),
				height: this.readInline(),
				depth: this.readInline(),
				offset: this.readInline(),
				bitmap: this.readInline()
			};
		case 35: // ColorForm
			return {
				width: this.readInline(),
				height: this.readInline(),
				depth: this.readInline(),
				offset: this.readInline(),
				bitmap: this.readInline(),
				colors: this.readInline()
			};
		}
		throw new Error('Unknown fixed format class ' + id);
	},
	readInline: function () {
		var id = this._stream.uint8();
		switch (id) {
		case 1: // nil
			return null;
		case 2: // True
			return true;
		case 3: // False
			return false;
		case 4: // SmallInteger
			return this._stream.int32();
		case 5: // SmallInteger16
			return this._stream.int16();
		case 6: //LargePositiveInteger
		case 7: //LargeNegativeInteger
			var d1 = 0;
			var d2 = 1;
			var i = this._stream.uint16();
			while (i--) {
				var k = this._stream.uint8();
				d1 += d2 * k;
				d2 *= 256;
			}
			return id == 7 ? -d1 : d1;
		case 8: // Float
			return this._stream.float64();
		case 99:
			return {
				isRef: true,
				index: this._stream.uint24()
			};
		}
		throw new Error('Unknown inline class ' + id);
	},
	fixObjectRefs: function (table, object) {
		var id = object.id;
		if (id < 99) {
			this.fixFixedFormat(table, object);
			return;
		}
		var fields = object.fields;
		var i = fields.length;
		while (i--) {
			fields[i] = this.deRef(table, fields[i]);
		}
	},
	fixFixedFormat: function (table, object) {
		var id = object.id;
		switch (id) {
		case 20:
		case 21:
			var fields = object.object;
			var i = fields.length
			while (i--) {
				fields[i] = this.deRef(table, fields[i]);
			}
			break;
		case 24:
		case 25:
			var fields = object.object;
			var i = 0;
			while (fields[i]) {
				fields[this.deRef(table, fields[i][0])] = this.deRef(table, fields[i][1]);
				delete fields[i];
				i++;
			}
			break;
		case 35:
			object.object.colors = this.deRef(table, object.object.colors);
		case 34:
			object.object.bitmap = this.deRef(table, object.object.bitmap);
			object.object.canvas = this.buildImage(object.object);
			break;
		}
	},
	deRef: function (table, object) {
		if (object && object.isRef) {
			var obj = table[object.index - 1];
			return obj.object || obj;
		}
		return object && object.object || object;
	},
	buildImage: function (image) {
		var bitmap = image.bitmap;
		
		var canvas = document.createElement('canvas');
		canvas.width = image.width;
		canvas.height = image.height;
		var ctx = canvas.getContext('2d');
		
		var data = ctx.createImageData(image.width, image.height);
		
		if (image.depth === 32) {
			if (!bitmap.bitmap) {
				this.decompressBitmapFlip(bitmap, data.data);
			}
		} else if (image.depth <= 8) {
			var indexes = bitmap.bitmap ? bitmap : this.decompressBitmap(bitmap);
			
			var bits;
			
			if (image.depth === 8) {
				bits = indexes;
			} else {
				bits = new Uint8Array(indexes.length * (8 / image.depth));
				
				var mask = (1 << image.depth) - 1;
				
				var parts = 8 / image.depth;
				
				var i,
					j = 0,
					k, l;
				
				for (i = 0; i < indexes.length; i++) {
					l = indexes[i];
					k = 8;
					while ((k -= image.depth) >= 0) {
						bits[j++] = (l >> k) & mask;
					}
				}
			}
			
			var colors = image.colors || this.squeakColors;
			var array = data.data;
			
			i = 0;
			j = 0;
			
			var c, b;
			
			k = array.length;
			while (k--) {
				c = colors[bits[j++]];
				if (c) {
					array[i++] = c.r;
					array[i++] = c.g;
					array[i++] = c.b;
					array[i++] = c.a === 0 ? 0 : 0xff;
				} else {
					i += 4;
				}
			}
		}
		
		ctx.putImageData(data, 0, 0);
		
		return canvas;
	},
	decompressBitmapFlip: function (src, out) {
		var stream = new sb.ByteStream(src.buffer);
		var nInt = function () {
			var i = stream.uint8();
			return i <= 223 ? i : (i <= 254 ? (i - 224) * 256 + stream.uint8() : stream.uint32());
		}
		var length = nInt() * 4;
		if (!out) {
			out = new Uint8Array(length);
		}
		
		var j, k, l, m, n, i = 0;
		
		while (i < length) {
			k = nInt();
			l = k >> 2;
			switch(k & 3) {
			case 0:
				i += 4;
				break;
			case 1:
				m = stream.uint8();
				while (l--) {
					out[i++] = m;
					out[i++] = m;
					out[i++] = m;
					out[i++] = m;
				}
				break;
			case 2:
				m = [stream.uint8(), stream.uint8(), stream.uint8(), stream.uint8()];
				while (l--) {
					out[i++] = m[1];
					out[i++] = m[2];
					out[i++] = m[3];
					out[i++] = m[0];
				}
				break;
			case 3:
				while (l--) {
					n = stream.uint8()
					out[i++] = stream.uint8();
					out[i++] = stream.uint8();
					out[i++] = stream.uint8();
					out[i++] = n;
				}
				break;
			}
		}
	},
	decompressBitmap: function (src) {
		var stream = new sb.ByteStream(src.buffer);
		var nInt = function () {
			var i = stream.uint8();
			return i <= 223 ? i : (i <= 254 ? (i - 224) * 256 + stream.uint8() : stream.uint32());
		}
		var length = nInt() * 4;
		var out = new Uint8Array(length);
		
		var j, k, l, m, n, i = 0;
		
		while (i < length) {
			k = nInt();
			l = k >> 2;
			switch(k & 3) {
			case 0:
				i += 4;
				break;
			case 1:
				m = stream.uint8();
				while (l--) {
					out[i++] = m;
					out[i++] = m;
					out[i++] = m;
					out[i++] = m;
				}
				break;
			case 2:
				m = [stream.uint8(), stream.uint8(), stream.uint8(), stream.uint8()];
				while (l--) {
					out[i++] = m[0];
					out[i++] = m[1];
					out[i++] = m[2];
					out[i++] = m[3];
				}
				break;
			case 3:
				while (l--) {
					out[i++] = stream.uint8();
					out[i++] = stream.uint8();
					out[i++] = stream.uint8();
					out[i++] = stream.uint8();
				}
				break;
			}
		}
		return out;
	},
	
	jsonify: function (object, parent) {
		if (object && object.id && this.readFormats[object.id]) {
			var self = this;
			var format = this.readFormats[object.id];
			var json = {};
			for (var field in format) {
				var value = format[field];
				var type = typeof value;
				var tmp;
				if (type === 'number') {
					tmp = object.fields[value];
				} else if (type === 'function') {
					tmp = value(object.fields, parent);
				} else {
					tmp = value;
				}
				
				json[field] = this.jsonify(tmp, object);
			}
			return json;
		} else if (object instanceof sb.Dict) {
			var json = {};
			for (var key in object) {
				json[key] = this.jsonify(object[key], parent);
			}
			return json;
		} else if (object instanceof Array) {
			var self = this;
			return object.map(function (d) {
				return self.jsonify(d, parent);
			});
		}
		return object;
	},
	
	readFormats: {
		124: {
			objName: 6,
			sounds: function (fields) {
				return fields[10].filter(function (media) {
					return media.id === 164;
				});
			},
			costumes: function (fields) {
				return fields[10].filter(function (media) {
					return media.id === 162;
				});
			},
			scratchX: function (fields, parent) {
				return fields[0].ox + fields[11].fields[2].x - parent.fields[0].cx / 2;
			},
			scratchY: function (fields, parent) {
				return parent.fields[0].cy / 2 - (fields[0].oy + fields[11].fields[2].y);
			},
			variables: function (fields) {
				var vars = fields[7];
				var varNames = Object.keys(vars);
				return varNames.map(function (d) {
					return {
						name: d,
						value: vars[d],
						isPersistent: false
					};
				});
			},
			lists: 20
		},
		125: { 
			objName: 6,
			sounds: function (fields) {
				return fields[10].filter(function (media) {
					return media.id === 164;
				});
			},
			costumes: function (fields) {
				return fields[10].filter(function (media) {
					return media.id === 162;
				});
			},
			children: 2,
			variables: function (fields) {
				var vars = fields[7];
				var varNames = Object.keys(vars);
				return varNames.map(function (d) {
					return {
						name: d,
						value: vars[d],
						isPersistent: false
					};
				});
			},
			lists: function (fields) {
				var lists = fields[20];
				var listNames = Object.keys(lists);
				return listNames.map(function (d) {
					return lists[d];
				});
			}
		},
		162: {
			costumeName: 0,
			rotationCenterX: function (fields) {
				return fields[2].x;
			},
			rotationCenterY: function (fields) {
				return fields[2].y;
			},
			image: function (fields) {
				return (fields[6] || fields[1]).canvas;
			},
		},
		164: {
			soundName: 0,
			sound: null
			// TODO: implement sound
		},
		175: {
			listName: 8,
			contents: 9,
			isPersistent: false,
			target: function (fields) {
				return fields[10].fields[6];
			},
			x: function (fields) {
				return fields[0].ox;
			},
			y: function (fields) {
				return fields[0].oy;
			},
			width:  function (fields) {
				return fields[0].cx - fields[0].ox;
			},
			height:  function (fields) {
				return fields[0].cy - fields[0].oy;
			},
			visible: function (fields) {
				return !!fields[1];
			},
		}
	}
});

(function () {
	var values = [
		0xff,0xff,0xff, 0x00,0x00,0x00,	0xff,0xff,0xff,	0x80,0x80,0x80,	0xff,0x00,0x00,	0x00,0xff,0x00,	0x00,0x00,0xff,	0x00,0xff,0xff,
		0xff,0xff,0x00,	0xff,0x00,0xff,	0x20,0x20,0x20,	0x40,0x40,0x40,	0x60,0x60,0x60,	0x9f,0x9f,0x9f,	0xbf,0xbf,0xbf,	0xdf,0xdf,0xdf,
		0x08,0x08,0x08,	0x10,0x10,0x10,	0x18,0x18,0x18,	0x28,0x28,0x28,	0x30,0x30,0x30,	0x38,0x38,0x38,	0x48,0x48,0x48,	0x50,0x50,0x50,
		0x58,0x58,0x58,	0x68,0x68,0x68,	0x70,0x70,0x70,	0x78,0x78,0x78,	0x87,0x87,0x87,	0x8f,0x8f,0x8f,	0x97,0x97,0x97,	0xa7,0xa7,0xa7,
		0xaf,0xaf,0xaf,	0xb7,0xb7,0xb7,	0xc7,0xc7,0xc7,	0xcf,0xcf,0xcf,	0xd7,0xd7,0xd7,	0xe7,0xe7,0xe7,	0xef,0xef,0xef,	0xf7,0xf7,0xf7,
		0x00,0x00,0x00,	0x00,0x33,0x00,	0x00,0x66,0x00, 0x00,0x99,0x00,	0x00,0xcc,0x00,	0x00,0xff,0x00,	0x00,0x00,0x33,	0x00,0x33,0x33,
		0x00,0x66,0x33,	0x00,0x99,0x33,	0x00,0xcc,0x33,	0x00,0xff,0x33,	0x00,0x00,0x66,	0x00,0x33,0x66,	0x00,0x66,0x66,	0x00,0x99,0x66,
		0x00,0xcc,0x66,	0x00,0xff,0x66,	0x00,0x00,0x99,	0x00,0x33,0x99,	0x00,0x66,0x99,	0x00,0x99,0x99,	0x00,0xcc,0x99,	0x00,0xff,0x99,
		0x00,0x00,0xcc, 0x00,0x33,0xcc,	0x00,0x66,0xcc,	0x00,0x99,0xcc,	0x00,0xcc,0xcc,	0x00,0xff,0xcc,	0x00,0x00,0xff,	0x00,0x33,0xff,
		0x00,0x66,0xff,	0x00,0x99,0xff,	0x00,0xcc,0xff,	0x00,0xff,0xff,	0x33,0x00,0x00,	0x33,0x33,0x00,	0x33,0x66,0x00, 0x33,0x99,0x00,
		0x33,0xcc,0x00,	0x33,0xff,0x00,	0x33,0x00,0x33,	0x33,0x33,0x33,	0x33,0x66,0x33,	0x33,0x99,0x33,	0x33,0xcc,0x33,	0x33,0xff,0x33,
		0x33,0x00,0x66,	0x33,0x33,0x66,	0x33,0x66,0x66,	0x33,0x99,0x66,	0x33,0xcc,0x66,	0x33,0xff,0x66,	0x33,0x00,0x99,	0x33,0x33,0x99,
		0x33,0x66,0x99,	0x33,0x99,0x99,	0x33,0xcc,0x99, 0x33,0xff,0x99,	0x33,0x00,0xcc,	0x33,0x33,0xcc,	0x33,0x66,0xcc,	0x33,0x99,0xcc,
		0x33,0xcc,0xcc,	0x33,0xff,0xcc,	0x33,0x00,0xff,	0x33,0x33,0xff,	0x33,0x66,0xff,	0x33,0x99,0xff,	0x33,0xcc,0xff,	0x33,0xff,0xff,
		0x66,0x00,0x00, 0x66,0x33,0x00,	0x66,0x66,0x00,	0x66,0x99,0x00,	0x66,0xcc,0x00,	0x66,0xff,0x00,	0x66,0x00,0x33,	0x66,0x33,0x33,
		0x66,0x66,0x33,	0x66,0x99,0x33,	0x66,0xcc,0x33,	0x66,0xff,0x33,	0x66,0x00,0x66,	0x66,0x33,0x66,	0x66,0x66,0x66,	0x66,0x99,0x66,
		0x66,0xcc,0x66,	0x66,0xff,0x66,	0x66,0x00,0x99,	0x66,0x33,0x99,	0x66,0x66,0x99,	0x66,0x99,0x99,	0x66,0xcc,0x99, 0x66,0xff,0x99,
		0x66,0x00,0xcc,	0x66,0x33,0xcc,	0x66,0x66,0xcc, 0x66,0x99,0xcc,	0x66,0xcc,0xcc,	0x66,0xff,0xcc,	0x66,0x00,0xff, 0x66,0x33,0xff,
		0x66,0x66,0xff,	0x66,0x99,0xff,	0x66,0xcc,0xff,	0x66,0xff,0xff,	0x99,0x00,0x00,	0x99,0x33,0x00,	0x99,0x66,0x00,	0x99,0x99,0x00,
		0x99,0xcc,0x00,	0x99,0xff,0x00,	0x99,0x00,0x33,	0x99,0x33,0x33,	0x99,0x66,0x33,	0x99,0x99,0x33,	0x99,0xcc,0x33,	0x99,0xff,0x33,
		0x99,0x00,0x66,	0x99,0x33,0x66,	0x99,0x66,0x66,	0x99,0x99,0x66,	0x99,0xcc,0x66,	0x99,0xff,0x66,	0x99,0x00,0x99,	0x99,0x33,0x99,
		0x99,0x66,0x99,	0x99,0x99,0x99,	0x99,0xcc,0x99,	0x99,0xff,0x99,	0x99,0x00,0xcc,	0x99,0x33,0xcc,	0x99,0x66,0xcc,	0x99,0x99,0xcc,
		0x99,0xcc,0xcc,	0x99,0xff,0xcc,	0x99,0x00,0xff,	0x99,0x33,0xff,	0x99,0x66,0xff,	0x99,0x99,0xff,	0x99,0xcc,0xff,	0x99,0xff,0xff,
		0xcc,0x00,0x00,	0xcc,0x33,0x00,	0xcc,0x66,0x00,	0xcc,0x99,0x00,	0xcc,0xcc,0x00,	0xcc,0xff,0x00,	0xcc,0x00,0x33,	0xcc,0x33,0x33,
		0xcc,0x66,0x33,	0xcc,0x99,0x33,	0xcc,0xcc,0x33,	0xcc,0xff,0x33,	0xcc,0x00,0x66, 0xcc,0x33,0x66,	0xcc,0x66,0x66,	0xcc,0x99,0x66,
		0xcc,0xcc,0x66,	0xcc,0xff,0x66,	0xcc,0x00,0x99,	0xcc,0x33,0x99,	0xcc,0x66,0x99,	0xcc,0x99,0x99,	0xcc,0xcc,0x99,	0xcc,0xff,0x99,
		0xcc,0x00,0xcc,	0xcc,0x33,0xcc,	0xcc,0x66,0xcc, 0xcc,0x99,0xcc,	0xcc,0xcc,0xcc,	0xcc,0xff,0xcc,	0xcc,0x00,0xff,	0xcc,0x33,0xff,
		0xcc,0x66,0xff,	0xcc,0x99,0xff,	0xcc,0xcc,0xff,	0xcc,0xff,0xff,	0xff,0x00,0x00,	0xff,0x33,0x00,	0xff,0x66,0x00,	0xff,0x99,0x00,
		0xff,0xcc,0x00,	0xff,0xff,0x00,	0xff,0x00,0x33, 0xff,0x33,0x33,	0xff,0x66,0x33,	0xff,0x99,0x33,	0xff,0xcc,0x33,	0xff,0xff,0x33,
		0xff,0x00,0x66,	0xff,0x33,0x66,	0xff,0x66,0x66,	0xff,0x99,0x66,	0xff,0xcc,0x66,	0xff,0xff,0x66,	0xff,0x00,0x99,	0xff,0x33,0x99,
		0xff,0x66,0x99,	0xff,0x99,0x99,	0xff,0xcc,0x99,	0xff,0xff,0x99,	0xff,0x00,0xcc,	0xff,0x33,0xcc,	0xff,0x66,0xcc,	0xff,0x99,0xcc,
		0xff,0xcc,0xcc,	0xff,0xff,0xcc,	0xff,0x00,0xff,	0xff,0x33,0xff,	0xff,0x66,0xff,	0xff,0x99,0xff,	0xff,0xcc,0xff
	];
	var colors = [];
	var i = 0;
	while (i < values.length) {
		colors.push({
			r: values[i++],
			g: values[i++],
			b: values[i++],
			a: 0xff
		});
	}
	sb.ObjectStream.prototype.squeakColors = colors;
}) ();

sb.Dict = function () {};