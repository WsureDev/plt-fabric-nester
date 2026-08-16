# PLT 布料紧凑排版

主程序是 Vite + TypeScript 静态网页应用。PLT 文件只在浏览器本地读取，
不会上传到服务器。程序会识别裁片、保留内部标记、按 1450 毫米布宽紧凑
排版；填写余料长度后，会自动生成 A 余料版、B 新料版、PLT、PNG 审核预览和
JSON 清单。

## 本地运行

```powershell
npm install
npm run dev
```

打开 Vite 输出的网址，选择 PLT 文件；只有存在余料时才填写余料长度，然后
点击开始排版。默认裁片间距和排版栅格均为 `1 毫米`，边缘留量为 `5 毫米`。
默认只考虑 0 度和 180 度，以保持布料纹向；确认布料允许横向裁剪后，才勾选
90 度旋转。排版计算在 Web Worker 中执行，耗时较长时界面仍可操作。

## 部署

```powershell
npm run build
```

将生成的 `dist/` 目录部署到任意静态网站即可，不需要服务器接口或运行时服务。

## 兼容命令行

`plt_nester.py` 仍可用于本地批处理，默认同样使用 1 毫米间距和 1 毫米栅格：

```powershell
python3 .\plt_nester.py '.\YWKBDXQ05_座套拼图版.plt' --output-dir .\nested_output
```

HP-GL 坐标默认按 40 单位/毫米换算；只有裁剪机使用其他标定值时才需要覆盖该参数。
