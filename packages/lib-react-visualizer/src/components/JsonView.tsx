import React, { JSX } from 'react';
import {
  JsonView as JsonViewLib,
  allExpanded,
  defaultStyles,
} from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';

void React;

export const JsonView = ({ src }: { src: unknown }): JSX.Element => (
  <JsonViewLib
    data={typeof src === 'object' && src !== null ? src : { src }}
    style={defaultStyles}
    shouldExpandNode={allExpanded}
  />
);
